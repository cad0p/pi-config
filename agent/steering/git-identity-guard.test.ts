import { afterEach, beforeEach, describe, it } from "node:test";
import { expectAllows, expectBlocks, loadHarness } from "@cad0p/pi-steering/testing";
import { homedir } from "node:os";
import { join } from "node:path";
import config from "./index.ts";

const H = homedir();

type EnvVars = Record<string, string | undefined>;

const INHERITED_ENV_KEYS = ["XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL"] as const;
const ORIGINAL_INHERITED = new Map(
	INHERITED_ENV_KEYS.map((k) => [k, process.env[k]]),
);

function restoreInheritedEnv(): void {
	for (const k of INHERITED_ENV_KEYS) {
		const v = ORIGINAL_INHERITED.get(k);
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

/** Run a callback with the inherited (process) env stubbed, then restore it. */
async function withInheritedEnv(
	vars: EnvVars,
	fn: () => Promise<void>,
): Promise<void> {
	const saved = new Map<string, string | undefined>();
	for (const [k, v] of Object.entries(vars)) {
		saved.set(k, process.env[k]);
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		await fn();
	} finally {
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

describe("git-identity-guard", () => {
	const harness = loadHarness({ config });

	// This host exports XDG_CONFIG_HOME=/home/pier/.config, so inherited
	// values must never leak into a case by accident. Cases that need an
	// inherited value inject it explicitly with withInheritedEnv.
	beforeEach(() => {
		delete process.env.XDG_CONFIG_HOME;
		delete process.env.GIT_CONFIG_GLOBAL;
	});
	afterEach(restoreInheritedEnv);

	// the incident's shape, and its variants
	for (const command of [
		"git config --global user.name t",
		"git config --global user.email t@t",
		"git config --global user.name \"Pier Carlo Cadoppi\"",
		"git config --global user.signingkey ~/.ssh/other.pub",
		"git config --global commit.gpgsign false",
		"git config --global gpg.format openpgp",
		"git config --global --replace-all user.email x@y",
		"git config --global --add user.email x@y",
		"git config --global --unset user.email",
		"git config --global --remove-section user",
		"git config --global -e",
		"git config set --global user.email t@t",
		"git config unset --global user.name",
		"git config edit --global",
		"git config --system user.email t@t",
		"git config --file ~/.gitconfig user.name t",
		`git config -f ${H}/.config/git/config user.email t@t`,
		"git -C /tmp config --global user.name t",
		"cd /tmp && git config --global user.name t",
		"bash -c 'git config --global user.email t@t'",
		`HOME=${H} git config --global user.name t`,
	]) {
		it(`blocks: ${command}`, async () => {
			await expectBlocks(harness, { command });
		});
	}

	it("blocks write of ~/.config/git/config", async () => {
		await expectBlocks(harness, { write: { path: `${H}/.config/git/config`, content: "" } });
	});
	it("blocks edit of ~/.gitconfig", async () => {
		await expectBlocks(harness, { edit: { path: `${H}/.gitconfig`, edits: [] } });
	});
	it("blocks sed -i on the global config", async () => {
		await expectBlocks(harness, { command: "sed -i 's/t@t/x/' ~/.config/git/config" });
	});
	it("blocks tee -a into ~/.gitconfig", async () => {
		await expectBlocks(harness, { command: `printf '[user]\\n' | tee -a ${H}/.gitconfig` });
	});

	// 2026-11-06 03:22Z: an inherited XDG_CONFIG_HOME made a scratch
	// HOME write the REAL ~/.config/git/config. A global write is real
	// if EITHER candidate git may choose is the real file.
	describe("inherited XDG_CONFIG_HOME / GIT_CONFIG_GLOBAL", () => {
		for (const [key, value] of [
			["user.name", '"gatev lens"'],
			["user.email", "gatev@example.com"],
			["user.signingkey", "/tmp/h/key.pub"],
		] as const) {
			it("blocks scratch HOME with inherited real XDG: " + key, async () => {
				await withInheritedEnv(
					{ XDG_CONFIG_HOME: join(H, ".config") },
					async () => {
						await expectBlocks(harness, {
							command:
								"HOME=/data/tmp/scratch-home git config --global " +
								key +
								" " +
								value,
						});
					},
				);
			});
		}

		for (const real of [join(H, ".gitconfig"), join(H, ".config", "git", "config")]) {
			it("blocks with inherited real GIT_CONFIG_GLOBAL=" + real + " and only HOME overridden", async () => {
				await withInheritedEnv({ GIT_CONFIG_GLOBAL: real }, async () => {
					await expectBlocks(harness, {
						command: "HOME=/tmp/h git config --global user.name x",
					});
				});
			});
		}

		it("still refuses inherited real GIT_CONFIG_GLOBAL with isolated HOME + XDG", async () => {
			await withInheritedEnv(
				{ GIT_CONFIG_GLOBAL: join(H, ".gitconfig") },
				async () => {
					await expectBlocks(harness, {
						command:
							"HOME=/tmp/h XDG_CONFIG_HOME=/tmp/h/.config git config --global user.name x",
					});
				},
			);
		});

		it("allows isolated HOME + isolated XDG under inherited real XDG", async () => {
			await withInheritedEnv(
				{ XDG_CONFIG_HOME: join(H, ".config") },
				async () => {
					await expectAllows(harness, {
						command:
							"HOME=/tmp/h XDG_CONFIG_HOME=/tmp/h/.config git config --global user.name x",
					});
				},
			);
		});

		it("allows command GIT_CONFIG_GLOBAL=<scratch> under inherited real XDG", async () => {
			await withInheritedEnv(
				{ XDG_CONFIG_HOME: join(H, ".config") },
				async () => {
					await expectAllows(harness, {
						command:
							"GIT_CONFIG_GLOBAL=/tmp/h/gitconfig git config --global user.name x",
					});
				},
			);
		});

		it("allows command GIT_CONFIG_GLOBAL to override an inherited real one", async () => {
			await withInheritedEnv(
				{ GIT_CONFIG_GLOBAL: join(H, ".gitconfig") },
				async () => {
					await expectAllows(harness, {
						command:
							"GIT_CONFIG_GLOBAL=/tmp/h/gitconfig git config --global user.name x",
					});
				},
			);
		});

		it("treats an empty command XDG_CONFIG_HOME= as unset (does not reuse inherited real XDG)", async () => {
			await withInheritedEnv(
				{ XDG_CONFIG_HOME: join(H, ".config") },
				async () => {
					await expectAllows(harness, {
						command:
							"XDG_CONFIG_HOME= HOME=/tmp/h git config --global user.name x",
					});
				},
			);
		});

		it("treats an empty command GIT_CONFIG_GLOBAL= as unset (falls back to real HOME)", async () => {
			await expectBlocks(harness, {
				command: "GIT_CONFIG_GLOBAL= git config --global user.name x",
			});
		});

		it("treats an empty command XDG_CONFIG_HOME= as unset (falls back to real HOME)", async () => {
			await expectBlocks(harness, {
				command: "XDG_CONFIG_HOME= git config --global user.name x",
			});
		});

		it("blocks a writer that names $XDG_CONFIG_HOME/git/config under inherited real XDG", async () => {
			await withInheritedEnv(
				{ XDG_CONFIG_HOME: join(H, ".config") },
				async () => {
					await expectBlocks(harness, {
						command: "sed -i 's/t/x/' $XDG_CONFIG_HOME/git/config",
					});
				},
			);
		});

		it("blocks a writer whose same-command prefix does not bind $XDG_CONFIG_HOME (bash expands first)", async () => {
			await withInheritedEnv(
				{ XDG_CONFIG_HOME: join(H, ".config") },
				async () => {
					await expectBlocks(harness, {
						command:
							"XDG_CONFIG_HOME=/tmp/h/.config sed -i 's/t/x/' $XDG_CONFIG_HOME/git/config",
					});
				},
			);
		});

		it("allows a writer whose $XDG_CONFIG_HOME was exported to an isolated dir", async () => {
			await expectAllows(harness, {
				command:
					"export XDG_CONFIG_HOME=/tmp/h/.config && sed -i 's/t/x/' $XDG_CONFIG_HOME/git/config",
			});
		});

		it("blocks a writer that names $GIT_CONFIG_GLOBAL under an inherited real value", async () => {
			await withInheritedEnv(
				{ GIT_CONFIG_GLOBAL: join(H, ".gitconfig") },
				async () => {
					await expectBlocks(harness, {
						command: "printf '[user]\\n' | tee -a $GIT_CONFIG_GLOBAL",
					});
				},
			);
		});
	});

	for (const command of [
		"git config --global --get user.email",
		"git config --global user.email",
		"git config --global -l",
		"git config --show-origin --get user.email",
		"git config get --global user.email",
		"git config user.email dev@pcad.it",
		"git config --local user.name t",
		"cd /tmp/feature-repo && git -c user.email=t@t -c user.name=t log -1",
		"git config --global pull.rebase true",
		"git config --global --unset pull.rebase",
		"HOME=/tmp/h git config --global user.name t",
		"GIT_CONFIG_GLOBAL=/tmp/gc git config --global user.email t@t",
		"export HOME=/tmp/h && git config --global user.email t@t",
		"git config --file /tmp/x.cfg user.email t@t",
		"cat ~/.config/git/config",
		"cp ~/.gitconfig.bak /tmp/x",
	]) {
		it(`allows: ${command}`, async () => {
			await expectAllows(harness, { command });
		});
	}
	it("allows write of a repo .gitconfig fixture", async () => {
		await expectAllows(harness, { write: { path: "/tmp/repo/.gitconfig", content: "" } });
	});
});
