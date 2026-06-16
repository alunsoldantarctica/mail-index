//! mail-index onboarding shell.
//!
//! Thin GUI over the `mail-index` and `gog` CLIs. Each Tauri command shells out
//! to a CLI and (where the CLI emits `--json` step events) streams those events
//! back to the frontend on the `step://event` channel.
//!
//! The CLI engine is built in parallel; we code against these documented
//! interfaces:
//!   - `mail-index status --json`                       -> StatusReport JSON
//!   - `mail-index setup --account <> --adapter <> --json` -> NDJSON step events
//!   - `mail-index sync --account <> --since <>`         -> human progress (lines)

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// A step event surfaced to the frontend stepper / log.
#[derive(Clone, Serialize)]
struct StepEvent {
    step: String,
    status: String, // "pending" | "running" | "done" | "action-needed"
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<f64>,
}

fn emit(app: &AppHandle, ev: StepEvent) {
    let _ = app.emit("step://event", ev);
}

fn step(app: &AppHandle, step: &str, status: &str, message: impl Into<Option<String>>) {
    emit(
        app,
        StepEvent {
            step: step.to_string(),
            status: status.to_string(),
            message: message.into(),
            progress: None,
        },
    );
}

/// Resolve the bundled `mail-index` binary path, falling back to PATH.
///
/// We bundle the CLI as a sidecar/resource; if that lookup fails (e.g. dev),
/// fall back to the plain command name so a globally-installed CLI works.
fn mail_index_program(app: &AppHandle) -> String {
    if let Ok(dir) = app.path().resource_dir() {
        let candidate = dir.join("bin").join(if cfg!(windows) {
            "mail-index.exe"
        } else {
            "mail-index"
        });
        if candidate.exists() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    "mail-index".to_string()
}

/// Path to the OAuth client JSON injected at build time from Bitwarden
/// (`mail-index/GOOGLE_OAUTH_CLIENT` -> resources/google-oauth-client.json).
fn oauth_client_path(app: &AppHandle) -> Option<String> {
    let dir = app.path().resource_dir().ok()?;
    let p = dir.join("resources").join("google-oauth-client.json");
    p.exists().then(|| p.to_string_lossy().into_owned())
}

/// Run a command, parse each stdout line as a JSON step event if possible,
/// otherwise stream the raw line to the log under `default_step`.
async fn stream_command(
    app: &AppHandle,
    program: &str,
    args: Vec<String>,
    default_step: &str,
) -> Result<(), String> {
    let (mut rx, _child) = app
        .shell()
        .command(program)
        .args(args)
        .spawn()
        .map_err(|e| format!("failed to launch {program}: {e}"))?;

    let mut exit_ok = true;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                for line in text.lines() {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(line) {
                        Ok(v) if v.get("step").is_some() => {
                            emit(
                                app,
                                StepEvent {
                                    step: v
                                        .get("step")
                                        .and_then(Value::as_str)
                                        .unwrap_or(default_step)
                                        .to_string(),
                                    status: v
                                        .get("status")
                                        .and_then(Value::as_str)
                                        .unwrap_or("running")
                                        .to_string(),
                                    message: v
                                        .get("message")
                                        .and_then(Value::as_str)
                                        .map(str::to_string),
                                    progress: v.get("progress").and_then(Value::as_f64),
                                },
                            );
                        }
                        _ => step(app, default_step, "running", line.to_string()),
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                for line in text.lines() {
                    if !line.trim().is_empty() {
                        step(app, default_step, "running", line.trim().to_string());
                    }
                }
            }
            CommandEvent::Error(err) => {
                exit_ok = false;
                step(app, default_step, "action-needed", err);
            }
            CommandEvent::Terminated(payload) => {
                if payload.code != Some(0) {
                    exit_ok = false;
                }
            }
            _ => {}
        }
    }

    if exit_ok {
        Ok(())
    } else {
        Err(format!("{program} exited with an error"))
    }
}

/// `mail-index status --json` -> raw JSON passed straight to the frontend.
#[tauri::command]
async fn get_status(app: AppHandle) -> Result<Value, String> {
    let program = mail_index_program(&app);
    let output = app
        .shell()
        .command(&program)
        .args(["status", "--json"])
        .output()
        .await
        .map_err(|e| format!("failed to run status: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    serde_json::from_slice::<Value>(&output.stdout)
        .map_err(|e| format!("could not parse status JSON: {e}"))
}

/// Install prerequisites per-OS: the `gog` CLI helper.
/// macOS: `brew install openclaw/tap/gogcli`.
/// Windows: gog.exe must be downloaded + placed on PATH (we surface guidance).
#[tauri::command]
async fn install_prereqs(app: AppHandle) -> Result<(), String> {
    step(&app, "prereqs", "running", "Checking for gog…".to_string());

    // Already installed?
    let probe = app.shell().command("gog").args(["--version"]).output().await;
    if matches!(probe, Ok(o) if o.status.success()) {
        step(&app, "prereqs", "done", "gog already installed.".to_string());
        return verify_mail_index(&app).await;
    }

    #[cfg(target_os = "macos")]
    {
        step(&app, "prereqs", "running", "Installing gog via Homebrew…".to_string());
        stream_command(
            &app,
            "brew",
            vec![
                "install".into(),
                "openclaw/tap/gogcli".into(),
            ],
            "prereqs",
        )
        .await?;
    }

    #[cfg(target_os = "windows")]
    {
        // No silent installer for gog on Windows yet; guide the user.
        step(
            &app,
            "prereqs",
            "action-needed",
            "Download the gog release zip from \
             https://github.com/openclaw/gog/releases, unzip it, and place \
             gog.exe on your PATH, then click Install again."
                .to_string(),
        );
        return Err("gog must be installed manually on Windows".to_string());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        step(
            &app,
            "prereqs",
            "action-needed",
            "Install the gog CLI for your platform and re-run.".to_string(),
        );
        return Err("unsupported platform for automatic gog install".to_string());
    }

    verify_mail_index(&app).await
}

async fn verify_mail_index(app: &AppHandle) -> Result<(), String> {
    let program = mail_index_program(app);
    let out = app
        .shell()
        .command(&program)
        .args(["--version"])
        .output()
        .await
        .map_err(|e| format!("mail-index not runnable: {e}"))?;
    if out.status.success() {
        step(app, "prereqs", "done", "Prerequisites ready.".to_string());
        Ok(())
    } else {
        Err("bundled mail-index CLI failed to run".to_string())
    }
}

/// Run `mail-index setup` to place the bundled OAuth client and sign in.
///
/// `account` is the local label; `email` the Google address; `adapter` the
/// auth backend (e.g. "gog"). Streams `--json` step events to the frontend.
/// Under the hood the CLI runs:
///   gog auth add <email> --client mail-index --services gmail --gmail-scope=readonly
#[tauri::command]
async fn run_setup(
    app: AppHandle,
    account: String,
    email: String,
    adapter: String,
) -> Result<(), String> {
    step(&app, "signin", "running", format!("Setting up {email}…"));

    let mut args = vec![
        "setup".to_string(),
        "--account".to_string(),
        account,
        "--email".to_string(),
        email,
        "--adapter".to_string(),
        adapter,
        "--json".to_string(),
    ];

    // Pass the build-time-injected OAuth client if present.
    if let Some(client) = oauth_client_path(&app) {
        args.push("--client".to_string());
        args.push(client);
    } else {
        step(
            &app,
            "signin",
            "running",
            "No bundled OAuth client found; relying on CLI default.".to_string(),
        );
    }

    let program = mail_index_program(&app);
    stream_command(&app, &program, args, "signin").await?;
    step(&app, "signin", "done", "Signed in.".to_string());
    Ok(())
}

/// `mail-index sync --account <label> --since <window>` with streamed progress.
#[tauri::command]
async fn run_sync(app: AppHandle, account: String, since: String) -> Result<(), String> {
    step(&app, "sync", "running", format!("Syncing {account} ({since})…"));
    let program = mail_index_program(&app);
    stream_command(
        &app,
        &program,
        vec![
            "sync".into(),
            "--account".into(),
            account,
            "--since".into(),
            since,
        ],
        "sync",
    )
    .await?;
    step(&app, "sync", "done", "Sync complete.".to_string());
    Ok(())
}

/// Return the MCP server config snippet for the user to paste into their AI client.
#[tauri::command]
async fn open_mcp_help(app: AppHandle) -> Result<String, String> {
    let snippet = serde_json::to_string_pretty(&serde_json::json!({
        "mcpServers": {
            "mail-index": { "command": "mail-index-mcp" }
        }
    }))
    .map_err(|e| e.to_string())?;
    step(&app, "mcp", "done", "MCP config ready — see log.".to_string());
    Ok(snippet)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_status,
            install_prereqs,
            run_setup,
            run_sync,
            open_mcp_help,
        ])
        .run(tauri::generate_context!())
        .expect("error while running mail-index desktop");
}
