import * as path from "node:path";
import { Napkin } from "../sdk.js";
import { EXIT_ERROR } from "../utils/exit-codes.js";
import {
  bold,
  dim,
  error,
  type OutputOptions,
  output,
  success,
} from "../utils/output.js";
import { findAncestorVault, setGlobalVaultIfUnset } from "../utils/vault.js";

export interface InitOptions extends OutputOptions {
  path?: string;
  template?: string;
}

export async function init(opts: InitOptions) {
  const target = path.resolve(opts.path || process.cwd());

  // Refuse to create a nested vault inside an existing vault tree — napkin
  // init creates new vaults only. Check the PARENT of the target so a
  // target that is itself already a vault is not refused.
  const ancestorVault = findAncestorVault(path.dirname(target));
  if (ancestorVault) {
    error(
      `Refusing to initialize: a napkin vault already exists at` +
        ` ${ancestorVault}. napkin init creates new vaults only — run it in` +
        ` the directory you want as the vault root.`,
    );
    process.exit(EXIT_ERROR);
  }

  let result: ReturnType<typeof Napkin.scaffold>;
  try {
    result = Napkin.scaffold(target, {
      template: opts.template,
    });
  } catch (e: unknown) {
    error((e as Error).message);
    process.exit(EXIT_ERROR);
  }

  // First vault on the machine? Register it as the global default so
  // commands resolve it from any directory (and the kb_* tools / distill
  // pick it up on the next session). An existing valid default is an
  // explicit user choice and is never overwritten. result.path is the
  // .napkin/ dir — the global default points at the content root.
  const defaultVault = result.created
    ? setGlobalVaultIfUnset(path.dirname(result.path))
    : null;

  if (!result.created && !result.template) {
    output(opts, {
      json: () => ({ ...result, defaultVault: null }),
      human: () => {
        console.log(
          `${dim("Vault already initialized at")} ${bold(result.path)}`,
        );
      },
    });
    return;
  }

  output(opts, {
    json: () => ({ ...result, defaultVault }),
    human: () => {
      if (result.created) {
        console.log(`${dim("Initialized vault at")} ${bold(result.path)}`);
        if (defaultVault?.set) {
          console.log(
            `  ${dim("default vault")} ${bold(path.dirname(result.path))}` +
              ` (set in ${dim(defaultVault.configPath)})`,
          );
        }
      }
      if (result.template) {
        console.log(`  ${dim("template")} ${bold(result.template)}`);
        for (const f of result.files) {
          console.log(`  ${dim("created")} ${f}`);
        }
      }
      console.log("");
      success("Edit .napkin/NAPKIN.md to set your context.");
    },
  });
}

export async function initTemplates(opts: OutputOptions) {
  const templates = Napkin.vaultTemplates();

  output(opts, {
    json: () => ({ templates }),
    human: () => {
      for (const t of templates) {
        console.log(`${bold(t.name)} - ${t.description}`);
        console.log(`  ${dim("folders:")} ${t.dirs.join(", ")}`);
      }
    },
  });
}
