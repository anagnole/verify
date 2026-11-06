import dns from "node:dns";

dns.setDefaultResultOrder("ipv4first");

const api = "https://api.vultr.com/v2";

export function vultrKey() {
  return process.env.VULTR_API_KEY ?? "";
}

export async function vultr(method: string, route: string, body?: unknown) {
  const response = await fetch(`${api}${route}`, {
    method,
    headers: { authorization: `Bearer ${vultrKey()}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return {};
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Vultr ${method} ${route}: ${response.status} ${data.error ?? ""}`);
  return data;
}

export type InstanceSpec = {
  label: string;
  plan: string;
  region: string;
  osId?: number;
  snapshotId?: string;
  sshKeyIds?: string[];
  userData?: string;
  tags?: string[];
};

export async function createInstance(spec: InstanceSpec) {
  const data = await vultr("POST", "/instances", {
    region: spec.region,
    plan: spec.plan,
    label: spec.label,
    hostname: spec.label,
    ...(spec.snapshotId ? { snapshot_id: spec.snapshotId } : { os_id: spec.osId ?? 2284 }),
    sshkey_id: spec.sshKeyIds ?? [],
    user_data: spec.userData ? Buffer.from(spec.userData).toString("base64") : undefined,
    tags: spec.tags ?? ["verify"],
    backups: "disabled",
    enable_ipv6: false,
  });
  return data.instance as { id: string; main_ip: string; status: string; label: string };
}

export async function listInstances(tag = "verify") {
  const data = await vultr("GET", `/instances?per_page=100&tag=${encodeURIComponent(tag)}`);
  return (data.instances ?? []) as { id: string; label: string; main_ip: string; status: string; power_status: string; server_status: string; plan: string; region: string; date_created: string }[];
}

export async function deleteInstance(id: string) {
  await vultr("DELETE", `/instances/${id}`);
}
