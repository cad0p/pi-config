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

export interface InitOptions extends OutputOptions {
  path?: string;
  template?: string;
}

export async function init(opts: InitOptions) {
  let result: ReturnType<typeof Napkin.scaffold>;
  try {
    result = Napkin.scaffold(opts.path || process.cwd(), {
      template: opts.template,
    });
  } catch (e: unknown) {
    error((e as Error).message);
    process.exit(EXIT_ERROR);
  }

  if (!result.created && !result.template) {
    output(opts, {
      json: () => result,
      human: () => {
        console.log(
          `${dim("Vault already initialized at")} ${bold(result.path)}`,
        );
      },
    });
    return;
  }

  output(opts, {
    json: () => result,
    human: () => {
      if (result.created) {
        console.log(`${dim("Initialized vault at")} ${bold(result.path)}`);
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
