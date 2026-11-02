import { describe, it } from "node:test";
import { expectAllows, expectBlocks, loadHarness } from "@cad0p/pi-steering/testing";
import { homedir } from "node:os";
import config from "./index.ts";

const H = homedir();

describe("git-identity-guard", () => {
	const harness = loadHarness({ config });

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
