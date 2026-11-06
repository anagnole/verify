import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createInstance, deleteInstance, listInstances, vultr } from "../packages/control/vultr.ts";

const keyFile = path.join(os.homedir(), ".ssh", "verify_vultr");
const region = process.env.REGION ?? "fra";

async function sshKeyId() {
  if (!fs.existsSync(keyFile)) execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "verify-vultr", "-f", keyFile]);
  const publicKey = fs.readFileSync(`${keyFile}.pub`, "utf8").trim();
  const existing = await vultr("GET", "/ssh-keys?per_page=100");
  const found = (existing.ssh_keys ?? []).find((item: any) => item.ssh_key.trim() === publicKey);
  if (found) return found.id as string;
  const created = await vultr("POST", "/ssh-keys", { name: "verify-vultr", ssh_key: publicKey });
  return created.ssh_key.id as string;
}

async function waitForIp(id: string) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const { instance } = await vultr("GET", `/instances/${id}`);
    if (instance.main_ip && instance.main_ip !== "0.0.0.0" && instance.status === "active") return instance.main_ip as string;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error("instance never got an IP");
}

const [command, ...rest] = process.argv.slice(2);

if (command === "list") {
  for (const item of await listInstances()) console.log(`${item.id}  ${item.label.padEnd(28)} ${item.main_ip.padEnd(16)} ${item.plan.padEnd(22)} ${item.status}/${item.power_status}`);
} else if (command === "create") {
  const [role, label, plan] = rest;
  const sshKey = await sshKeyId();
  const instance = await createInstance({
    label: label ?? `verify-${role}`,
    plan: plan ?? (role === "control" ? "vc2-2c-4gb" : "vx1-g-4c-16g-240s"),
    region,
    sshKeyIds: [sshKey],
    tags: ["verify", `verify-${role}`],
  });
  console.log(`created ${instance.id}, waiting for its IP…`);
  console.log(await waitForIp(instance.id));
} else if (command === "snapshot") {
  const { snapshot } = await vultr("POST", "/snapshots", { instance_id: rest[0], description: rest[1] ?? "verify-worker" });
  console.log(snapshot.id);
} else if (command === "snapshot-status") {
  const { snapshot } = await vultr("GET", `/snapshots/${rest[0]}`);
  console.log(snapshot.status, snapshot.size);
} else if (command === "delete") {
  await deleteInstance(rest[0]);
  console.log("deleted");
} else if (command === "account") {
  const { account } = await vultr("GET", "/account");
  console.log(JSON.stringify(account, null, 2));
} else {
  console.log("usage: node infra/vultr.ts list | create control|worker [label] [plan] | snapshot <instance> | snapshot-status <id> | delete <instance> | account");
}
