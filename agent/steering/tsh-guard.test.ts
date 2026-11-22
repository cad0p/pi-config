// SPDX-License-Identifier: MIT
// tsh-guard tests — no agent may change the shared Teleport client state
// (~/.tsh). Matrix per the owner's brief (2026-11-08): every block form
// (plain, --proxy first, env wrapper, sudo -u, timeout, bash -c, && chain)
// plus the read/allow forms.
//
// The shared home on this host is /home/pier/.tsh; the write/edit surface
// is matched through the absolute path, ~ and $HOME forms.

import { describe, it } from "node:test";
import { expectAllows, expectBlocks, loadHarness } from "@cad0p/pi-steering/testing";
import config from "./index.ts";

const LOGIN = "no-shared-tsh-login";
const LOGOUT = "no-shared-tsh-logout";
const WRITE = "no-shared-tsh-profile-write";
const EDIT = "no-shared-tsh-profile-edit";
const BASH_WRITE = "no-shared-tsh-bash-write";
const PROXY = "tsh-needs-proxy";
const DISCOVERY = "tsh-discovery-all-clusters";
const WRONG_CLUSTER = "tsh-node-wrong-cluster";

const SHARED = "/home/pier/.tsh";
const PROXY_HOST = "teleport-admin.piercloud.net:443";
// The second cluster (incident 2026-11-22): pc-control and pc-control-mail
// live here, not behind the admin proxy.
const CONTROL_HOST = "teleport-control.piercloud.net:443";

describe("tsh-guard", () => {
	const harness = loadHarness({ config });

	// ---- rule 1: no-shared-tsh-login ----

	it("blocks plain tsh login", async () => {
		await expectBlocks(harness, { command: "tsh login" }, { rule: LOGIN });
	});
	it("blocks tsh login --user=…", async () => {
		await expectBlocks(harness, { command: "tsh login --user=pier" }, { rule: LOGIN });
	});
	it("blocks tsh --proxy=… login (proxy first)", async () => {
		await expectBlocks(harness, { command: `tsh --proxy=${PROXY_HOST} login` }, { rule: LOGIN });
	});
	it("blocks tsh --proxy … login (separate flag value)", async () => {
		await expectBlocks(harness, { command: `tsh --proxy ${PROXY_HOST} login` }, { rule: LOGIN });
	});
	it("blocks tsh login inside a && chain", async () => {
		await expectBlocks(harness, { command: "cd /data/tmp && tsh login" }, { rule: LOGIN });
	});
	it("blocks an env-wrapper prefix (FOO=1 tsh login)", async () => {
		await expectBlocks(harness, { command: "FOO=1 tsh login" }, { rule: LOGIN });
	});
	it("blocks env FOO=1 tsh login (env command wrapper)", async () => {
		await expectBlocks(harness, { command: "env FOO=1 tsh login" }, { rule: LOGIN });
	});
	it("blocks sudo -u pier tsh login", async () => {
		await expectBlocks(harness, { command: "sudo -u pier tsh login" }, { rule: LOGIN });
	});
	it("blocks timeout 30 tsh login", async () => {
		await expectBlocks(harness, { command: "timeout 30 tsh login" }, { rule: LOGIN });
	});
	it("blocks bash -c 'tsh login'", async () => {
		await expectBlocks(harness, { command: "bash -c 'tsh login'" }, { rule: LOGIN });
	});
	it("blocks TELEPORT_HOME=~/.tsh tsh login (shared home spelled as ~)", async () => {
		await expectBlocks(harness, { command: "TELEPORT_HOME=~/.tsh tsh login" }, { rule: LOGIN });
	});
	it("blocks TELEPORT_HOME=$HOME/.tsh tsh login", async () => {
		await expectBlocks(harness, { command: "TELEPORT_HOME=$HOME/.tsh tsh login" }, { rule: LOGIN });
	});
	it("blocks an exported shared TELEPORT_HOME", async () => {
		await expectBlocks(harness, { command: "export TELEPORT_HOME=~/.tsh && tsh login" }, { rule: LOGIN });
	});
	it("blocks an unresolvable TELEPORT_HOME (fail-closed)", async () => {
		await expectBlocks(harness, { command: "TELEPORT_HOME=$ISOLATED tsh login" }, { rule: LOGIN });
	});

	// ---- rule 2: no-shared-tsh-logout ----

	it("blocks plain tsh logout", async () => {
		await expectBlocks(harness, { command: "tsh logout" }, { rule: LOGOUT });
	});
	it("blocks tsh --proxy=… logout", async () => {
		await expectBlocks(harness, { command: `tsh --proxy=${PROXY_HOST} logout` }, { rule: LOGOUT });
	});
	it("blocks sudo -u pier tsh logout", async () => {
		await expectBlocks(harness, { command: "sudo -u pier tsh logout" }, { rule: LOGOUT });
	});
	it("blocks timeout 30 tsh logout", async () => {
		await expectBlocks(harness, { command: "timeout 30 tsh logout" }, { rule: LOGOUT });
	});

	// ---- rules 1/2 allows: isolated TELEPORT_HOME ----

	it("allows TELEPORT_HOME=/data/tmp/tshhome-574/.tsh tsh login", async () => {
		await expectAllows(harness, {
			command: `TELEPORT_HOME=/data/tmp/tshhome-574/.tsh tsh login --proxy=${PROXY_HOST}`,
		});
	});
	it("allows a plain isolated TELEPORT_HOME login", async () => {
		await expectAllows(harness, { command: "TELEPORT_HOME=/data/tmp/x tsh login" });
	});
	it("allows an in-chain exported isolated TELEPORT_HOME", async () => {
		await expectAllows(harness, { command: "export TELEPORT_HOME=/data/tmp/x && tsh login" });
	});
	it("allows an isolated TELEPORT_HOME logout", async () => {
		await expectAllows(harness, { command: "TELEPORT_HOME=/data/tmp/x tsh logout" });
	});

	// ---- rule 3: write/edit tools on paths under the shared home ----

	it("blocks write of /home/pier/.tsh/current-profile", async () => {
		await expectBlocks(harness, {
			write: { path: `${SHARED}/current-profile`, content: "other\n" },
		}, { rule: WRITE });
	});
	it("blocks write of ~/.tsh/…", async () => {
		await expectBlocks(harness, {
			write: { path: "~/.tsh/current-profile", content: "x" },
		}, { rule: WRITE });
	});
	it("blocks write of $HOME/.tsh/…", async () => {
		await expectBlocks(harness, {
			write: { path: "$HOME/.tsh/config.yaml", content: "x" },
		}, { rule: WRITE });
	});
	it("blocks edit of a per-proxy yaml under the shared home", async () => {
		await expectBlocks(harness, {
			edit: { path: `${SHARED}/teleport-admin.piercloud.net.yaml`, edits: [] },
		}, { rule: EDIT });
	});
	it("blocks edit of ~/.tsh/keys/…", async () => {
		await expectBlocks(harness, {
			edit: { path: "~/.tsh/keys/k", edits: [] },
		}, { rule: EDIT });
	});
	it("allows write under /data/tmp", async () => {
		await expectAllows(harness, { write: { path: "/data/tmp/x/current-profile", content: "x" } });
	});

	// ---- rule 3: bash writers into the shared home ----

	it("blocks cp INTO the shared home", async () => {
		await expectBlocks(harness, {
			command: "cp /data/tmp/current-profile ~/.tsh/current-profile",
		}, { rule: BASH_WRITE });
	});
	it("blocks cp -t <shared dir>", async () => {
		await expectBlocks(harness, {
			command: "cp -t ~/.tsh/keys k1 k2",
		}, { rule: BASH_WRITE });
	});
	it("blocks mv OUT of the shared home (removes the key from the home)", async () => {
		await expectBlocks(harness, {
			command: "mv ~/.tsh/keys/k /data/tmp/k",
		}, { rule: BASH_WRITE });
	});
	it("blocks rm -rf ~/.tsh/keys", async () => {
		await expectBlocks(harness, { command: "rm -rf ~/.tsh/keys" }, { rule: BASH_WRITE });
	});
	it("blocks rm -f ~/.tsh/current-profile", async () => {
		await expectBlocks(harness, { command: "rm -f ~/.tsh/current-profile" }, { rule: BASH_WRITE });
	});
	it("blocks tee into the shared home", async () => {
		await expectBlocks(harness, {
			command: "echo pier | tee ~/.tsh/current-profile",
		}, { rule: BASH_WRITE });
	});
	it("blocks sed -i on a shared-home file", async () => {
		await expectBlocks(harness, {
			command: "sed -i s/pier/other/ ~/.tsh/current-profile",
		}, { rule: BASH_WRITE });
	});
	it("blocks a relative write with an effective cwd inside the home", async () => {
		await expectBlocks(harness, {
			command: "cd ~/.tsh && rm current-profile",
		}, { rule: BASH_WRITE });
	});
	it("blocks a relative .tsh delete from the home dir", async () => {
		await expectBlocks(harness, {
			command: "cd /home/pier && rm -rf .tsh",
		}, { rule: BASH_WRITE });
	});
	it("blocks cp into the home inside a bash -c wrapper", async () => {
		await expectBlocks(harness, {
			command: "bash -c 'cp /data/tmp/x ~/.tsh/current-profile'",
		}, { rule: BASH_WRITE });
	});
	it("blocks cp into the home via sudo", async () => {
		await expectBlocks(harness, {
			command: "sudo -u pier cp /data/tmp/x ~/.tsh/current-profile",
		}, { rule: BASH_WRITE });
	});

	// ---- rule 3 allows: reads from the shared home ----

	it("allows cat ~/.tsh/current-profile", async () => {
		await expectAllows(harness, { command: "cat ~/.tsh/current-profile" });
	});
	it("allows ls -la ~/.tsh", async () => {
		await expectAllows(harness, { command: "ls -la ~/.tsh" });
	});
	it("allows cp -a ~/.tsh /data/tmp/x (copy OUT)", async () => {
		await expectAllows(harness, { command: "cp -a ~/.tsh /data/tmp/x" });
	});
	it("allows a non-in-place sed read of the profile", async () => {
		await expectAllows(harness, { command: "sed -n 1p ~/.tsh/current-profile" });
	});
	it("allows cp from the home into /data/tmp", async () => {
		await expectAllows(harness, {
			command: "cp ~/.tsh/keys/k /data/tmp/k",
		});
	});

	// ---- rule 4: tsh-needs-proxy ----

	it("blocks tsh ssh without a proxy pin", async () => {
		await expectBlocks(harness, {
			command: "tsh ssh deploy@pc-host-01 true",
		}, { rule: PROXY });
	});
	it("blocks tsh scp without a pin", async () => {
		await expectBlocks(harness, { command: "tsh scp f host:/tmp" }, { rule: PROXY });
	});
	// ls/status moved to tsh-discovery-all-clusters (rule 4 stays for the
	// other profile reads: ssh/scp/proxy/db/kube).
	it("blocks tsh ls without a pin", async () => {
		await expectBlocks(harness, { command: "tsh ls" }, { rule: DISCOVERY });
	});
	it("blocks tsh status without a pin", async () => {
		await expectBlocks(harness, { command: "tsh status" }, { rule: DISCOVERY });
	});
	it("blocks tsh proxy ssh without a pin", async () => {
		await expectBlocks(harness, { command: "tsh proxy ssh host true" }, { rule: PROXY });
	});
	it("blocks tsh db connect without a pin", async () => {
		await expectBlocks(harness, { command: "tsh db connect pg" }, { rule: PROXY });
	});
	it("blocks tsh kube ls without a pin", async () => {
		await expectBlocks(harness, { command: "tsh kube ls" }, { rule: PROXY });
	});
	it("blocks tsh --user=… ssh (flag, but no proxy)", async () => {
		await expectBlocks(harness, {
			command: "tsh --user=pier ssh host true",
		}, { rule: PROXY });
	});
	// The command was 'tsh status' until 2026-11-22 — status now belongs to
	// tsh-discovery-all-clusters, so the chain coverage uses ssh.
	it("blocks tsh ssh in a && chain", async () => {
		await expectBlocks(harness, { command: "cd /data/tmp && tsh ssh host true" }, { rule: PROXY });
	});
	it("blocks timeout 30 tsh ssh without a pin", async () => {
		await expectBlocks(harness, { command: "timeout 30 tsh ssh host true" }, { rule: PROXY });
	});
	it("blocks sudo -u pier tsh ssh without a pin", async () => {
		await expectBlocks(harness, { command: "sudo -u pier tsh ssh host true" }, { rule: PROXY });
	});
	it("blocks bash -c 'tsh ssh …' without a pin", async () => {
		await expectBlocks(harness, { command: "bash -c 'tsh ssh host true'" }, { rule: PROXY });
	});
	it("blocks an unresolvable TELEPORT_HOME without a pin (fail-closed)", async () => {
		await expectBlocks(harness, {
			command: "TELEPORT_HOME=$ISOLATED tsh ssh host true",
		}, { rule: PROXY });
	});

	it("allows tsh --proxy=… ssh", async () => {
		await expectAllows(harness, {
			command: `tsh --proxy=${PROXY_HOST} ssh deploy@pc-host-01 true`,
		});
	});
	it("allows tsh --proxy … ssh (separate value)", async () => {
		await expectAllows(harness, {
			command: `tsh --proxy ${PROXY_HOST} ssh deploy@pc-host-01 true`,
		});
	});
	it("allows a TELEPORT_PROXY prefix", async () => {
		await expectAllows(harness, {
			command: `TELEPORT_PROXY=${PROXY_HOST} tsh ssh deploy@pc-host-01 true`,
		});
	});
	it("allows an in-chain exported TELEPORT_PROXY", async () => {
		await expectAllows(harness, {
			command: `export TELEPORT_PROXY=${PROXY_HOST} && tsh ssh deploy@pc-host-01 true`,
		});
	});
	it("allows an isolated TELEPORT_HOME without a pin", async () => {
		await expectAllows(harness, {
			command: "TELEPORT_HOME=/data/tmp/tshhome-574/.tsh tsh ssh host true",
		});
	});
	// Was an allow before 2026-11-22; a pinned status is the narrow view
	// that produced the false "no access" conclusion, so it blocks too.
	it("blocks tsh --proxy=… status (pinned, one cluster)", async () => {
		await expectBlocks(harness, { command: `tsh --proxy=${PROXY_HOST} status` }, { rule: DISCOVERY });
	});
	it("allows tsh version", async () => {
		await expectAllows(harness, { command: "tsh version" });
	});
	it("allows a plain ssh (not tsh)", async () => {
		await expectAllows(harness, { command: "ssh host true" });
	});

	// ---- known gaps (see tsh-guard.ts header) ----

	// Redirect targets are not exposed to predicates (input.command is the
	// flattened ref text), so '>' into the shared home is invisible — the
	// same gap dev-shm-guard pins. 'tee' is covered above.
	it("KNOWN GAP: allows a redirect into ~/.tsh", async () => {
		await expectAllows(harness, { command: "echo other > ~/.tsh/current-profile" });
	});
	// 'timeout' is not a walker wrapper: the wrapped argv is visible for
	// the tsh subcommand predicates, but a wrapped cp is not a cp ref.
	it("KNOWN GAP: allows a cp wrapped in timeout", async () => {
		await expectAllows(harness, {
			command: "timeout 30 cp /data/tmp/x ~/.tsh/current-profile",
		});
	});
});

// ---------------------------------------------------------------------
// Cross-cluster discovery (incident 2026-11-22, H4-BOARD ~L1989-1993)
// ---------------------------------------------------------------------
describe("tsh-guard — cross-cluster discovery", () => {
	const harness = loadHarness({ config });

	// ---- tsh-discovery-all-clusters: a one-cluster listing is refused ----

	it("blocks bare tsh ls (current-profile decides the cluster)", async () => {
		await expectBlocks(harness, { command: "tsh ls" }, {
			rule: DISCOVERY,
			reason: /tsh-discover/,
		});
	});
	it("blocks tsh ls --proxy=teleport-admin… (the incident command)", async () => {
		await expectBlocks(harness, {
			command: "tsh ls --proxy=teleport-admin.piercloud.net",
		}, { rule: DISCOVERY });
	});
	it("names both clusters and the pc-control node in the reason", async () => {
		await expectBlocks(harness, { command: "tsh ls" }, {
			rule: DISCOVERY,
			reason: /teleport-admin\.piercloud\.net[\s\S]*teleport-control\.piercloud\.net[\s\S]*pc-control/,
		});
	});
	it("blocks a pinned tsh ls on the second cluster too", async () => {
		await expectBlocks(harness, {
			command: `tsh ls --proxy=${CONTROL_HOST}`,
		}, { rule: DISCOVERY });
	});
	it("blocks tsh status (the other one-cluster listing)", async () => {
		await expectBlocks(harness, { command: "tsh status" }, { rule: DISCOVERY });
	});
	it("blocks tsh clusters (leaf list of the pinned cluster)", async () => {
		await expectBlocks(harness, { command: "tsh clusters" }, { rule: DISCOVERY });
	});
	it("blocks timeout 30 tsh ls --proxy=…", async () => {
		await expectBlocks(harness, {
			command: `timeout 30 tsh ls --proxy=${CONTROL_HOST}`,
		}, { rule: DISCOVERY });
	});
	it("blocks tsh ls inside a && chain", async () => {
		await expectBlocks(harness, {
			command: `cd /data/tmp && tsh ls --proxy=${PROXY_HOST}`,
		}, { rule: DISCOVERY });
	});
	it("blocks bash -c 'tsh ls'", async () => {
		await expectBlocks(harness, { command: "bash -c 'tsh ls'" }, { rule: DISCOVERY });
	});
	it("blocks an unresolvable TELEPORT_HOME ls (fail-closed: counts as shared)", async () => {
		await expectBlocks(harness, { command: "TELEPORT_HOME=$ISOLATED tsh ls" }, {
			rule: DISCOVERY,
		});
	});
	it("blocks tsh --proxy=… ls --format=json", async () => {
		await expectBlocks(harness, {
			command: `tsh --proxy=${PROXY_HOST} ls --format=json`,
		}, { rule: DISCOVERY });
	});

	// ---- allows: isolated home, the helper itself, non-discovery verbs ----

	it("allows tsh ls on an isolated TELEPORT_HOME", async () => {
		await expectAllows(harness, { command: "TELEPORT_HOME=/data/tmp/x/.tsh tsh ls" });
	});
	it("allows a pinned tsh status on an isolated TELEPORT_HOME", async () => {
		await expectAllows(harness, {
			command: `TELEPORT_HOME=/data/tmp/x/.tsh tsh --proxy=${CONTROL_HOST} status`,
		});
	});
	it("allows the helper tsh-discover", async () => {
		await expectAllows(harness, { command: "tsh-discover" });
	});
	it("allows the helper by absolute path", async () => {
		await expectAllows(harness, {
			command: "/home/pier/.pi/agent/bin/tsh-discover",
		});
	});
	it("allows a bare list of the teleport home", async () => {
		await expectAllows(harness, { command: "ls ~/.tsh" });
	});

	// ---- tsh-node-wrong-cluster: a node in the other cluster ----

	it("blocks pc-control behind the admin proxy (the incident pair)", async () => {
		await expectBlocks(harness, {
			command: `tsh --proxy=${PROXY_HOST} ssh --user=pier deploy@pc-control`,
		}, { rule: WRONG_CLUSTER });
	});
	it("names the right proxy and the node in the reason", async () => {
		await expectBlocks(harness, {
			command: `tsh --proxy=${PROXY_HOST} ssh deploy@pc-control`,
		}, { rule: WRONG_CLUSTER, reason: /teleport-control\.piercloud\.net:443/ });
	});
	it("blocks pc-host-01 behind the control proxy", async () => {
		await expectBlocks(harness, {
			command: `tsh --proxy=${CONTROL_HOST} ssh pier@pc-host-01`,
		}, { rule: WRONG_CLUSTER });
	});
	it("blocks pc-control-mail behind the admin proxy", async () => {
		await expectBlocks(harness, {
			command: `TELEPORT_PROXY=${PROXY_HOST} tsh ssh deploy@pc-control-mail`,
		}, { rule: WRONG_CLUSTER });
	});
	it("blocks an scp whose node side is in the other cluster", async () => {
		await expectBlocks(harness, {
			command: `tsh --proxy=${CONTROL_HOST} scp deploy@pc-host-01:/etc/motd /data/tmp/motd`,
		}, { rule: WRONG_CLUSTER });
	});
	it("blocks sudo -u pier tsh ssh (wrapped, still placed)", async () => {
		await expectBlocks(harness, {
			command: `sudo -u pier tsh --proxy=${PROXY_HOST} ssh deploy@pc-control`,
		}, { rule: WRONG_CLUSTER });
	});

	// ---- allows: right pin, unknown node, unknown pin, isolated home ----

	it("allows pc-control behind the control proxy", async () => {
		await expectAllows(harness, {
			command: `tsh --proxy=${CONTROL_HOST} ssh --user=pier deploy@pc-control`,
		});
	});
	it("allows pc-control-mail behind the control proxy", async () => {
		await expectAllows(harness, {
			command: `tsh --proxy=${CONTROL_HOST} ssh deploy@pc-control-mail`,
		});
	});
	it("allows pc-host-01 behind the admin proxy", async () => {
		await expectAllows(harness, {
			command: `tsh --proxy=${PROXY_HOST} ssh deploy@pc-host-01 true`,
		});
	});
	it("allows an unknown node name (the map is incomplete by design)", async () => {
		await expectAllows(harness, {
			command: `tsh --proxy=${PROXY_HOST} ssh deploy@some-future-node true`,
		});
	});
	it("allows an unknown proxy pin (map cannot judge another cluster)", async () => {
		await expectAllows(harness, {
			command: "tsh --proxy=teleport-leaf.piercloud.net:443 ssh deploy@pc-control true",
		});
	});
	it("allows a wrong-cluster node on an isolated TELEPORT_HOME", async () => {
		await expectAllows(harness, {
			command: `TELEPORT_HOME=/data/tmp/x/.tsh tsh --proxy=${PROXY_HOST} ssh deploy@pc-control true`,
		});
	});
	it("blocks an unpinned wrong-cluster node with tsh-needs-proxy", async () => {
		await expectBlocks(harness, {
			command: "tsh ssh --user=pier deploy@pc-control",
		}, { rule: PROXY });
	});
});

