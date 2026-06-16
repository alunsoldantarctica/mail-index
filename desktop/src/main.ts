import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type StepName = "prereqs" | "signin" | "sync" | "mcp";
type Status = "pending" | "running" | "done" | "action-needed";

// A single JSON step event emitted by `mail-index setup --json` (and our Rust shims).
interface StepEvent {
  step: string; // e.g. "prereqs", "auth", "sync"
  status: Status;
  message?: string;
  progress?: number; // 0..1, optional
}

// Shape returned by `mail-index status --json` (engine being built in parallel).
interface StatusReport {
  accounts: Array<{
    label: string;
    email?: string;
    messages?: number;
    lastSync?: string;
    authed?: boolean;
  }>;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const logEl = $<HTMLPreElement>("#log");
const emailEl = $<HTMLInputElement>("#email");
const labelEl = $<HTMLInputElement>("#label");

function log(line: string) {
  logEl.textContent += line.replace(/\n+$/, "") + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function setStepStatus(step: StepName, status: Status) {
  const dot = document.querySelector(`.step[data-step="${step}"] .dot`);
  if (dot) dot.setAttribute("data-status", status);
}

function setBusy(busy: boolean) {
  document.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((b) => {
    b.disabled = busy;
  });
}

function account(): { email: string; label: string } {
  return { email: emailEl.value.trim(), label: labelEl.value.trim() || "personal" };
}

// Map backend step ids -> stepper rows.
function rowFor(stepId: string): StepName | null {
  if (stepId.startsWith("prereq")) return "prereqs";
  if (stepId.startsWith("auth") || stepId.startsWith("signin")) return "signin";
  if (stepId.startsWith("sync")) return "sync";
  return null;
}

// Stream of `step://event` events emitted by the Rust commands.
listen<StepEvent>("step://event", (e) => {
  const ev = e.payload;
  if (ev.message) log(`[${ev.step}] ${ev.message}`);
  const row = rowFor(ev.step);
  if (row) setStepStatus(row, ev.status);
});

async function refreshStatus() {
  try {
    const report = await invoke<StatusReport>("get_status");
    const { label } = account();
    const acct = report.accounts.find((a) => a.label === label);
    if (!acct) {
      log(`status: no account "${label}" yet.`);
      return;
    }
    if (acct.authed) setStepStatus("signin", "done");
    if (acct.messages && acct.messages > 0) {
      setStepStatus("sync", "done");
      log(`status: ${label} — ${acct.messages} messages, last sync ${acct.lastSync ?? "n/a"}.`);
    }
  } catch (err) {
    log(`status error: ${String(err)}`);
  }
}

async function run(step: StepName, fn: () => Promise<unknown>) {
  setBusy(true);
  setStepStatus(step, "running");
  try {
    await fn();
    setStepStatus(step, "done");
  } catch (err) {
    setStepStatus(step, "action-needed");
    log(`error: ${String(err)}`);
  } finally {
    setBusy(false);
  }
}

const handlers: Record<StepName, () => Promise<unknown>> = {
  prereqs: () => invoke("install_prereqs"),
  signin: () => {
    const { email, label } = account();
    if (!email) throw new Error("Enter your Google email first.");
    return invoke("run_setup", { account: label, email, adapter: "gog" });
  },
  sync: () => {
    const { label } = account();
    return invoke("run_sync", { account: label, since: "1mo" });
  },
  mcp: async () => {
    const snippet = await invoke<string>("open_mcp_help");
    log(snippet);
  },
};

document.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((btn) => {
  const action = btn.dataset.action as StepName;
  btn.addEventListener("click", () => run(action, handlers[action]));
});

$<HTMLButtonElement>("#refresh").addEventListener("click", refreshStatus);

// Probe status on launch so returning users see where they left off.
refreshStatus();
