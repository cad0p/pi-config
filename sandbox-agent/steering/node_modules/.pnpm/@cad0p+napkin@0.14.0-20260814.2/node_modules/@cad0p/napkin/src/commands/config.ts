import { Napkin } from "../sdk.js";
import { EXIT_USER_ERROR } from "../utils/exit-codes.js";
import {
  bold,
  dim,
  error,
  type OutputOptions,
  output,
} from "../utils/output.js";

export async function configShow(opts: OutputOptions & { vault?: string }) {
  const n = new Napkin(opts.vault || process.cwd());
  const config = n.config();

  output(opts, {
    json: () => config,
    human: () => {
      console.log(JSON.stringify(config, null, 2));
    },
  });
}

export async function configSet(
  opts: OutputOptions & { vault?: string; key?: string; value?: string },
) {
  const n = new Napkin(opts.vault || process.cwd());

  if (!opts.key || opts.value === undefined) {
    error("Usage: napkin config set --key <path> --value <value>");
    process.exit(EXIT_USER_ERROR);
  }

  const { config: updated, parsed } = n.configSet(opts.key, opts.value);

  output(opts, {
    json: () => updated,
    human: () => {
      console.log(
        `${dim("set")} ${bold(opts.key as string)} = ${JSON.stringify(parsed)}`,
      );
    },
  });
}

export async function configGet(
  opts: OutputOptions & { vault?: string; key?: string },
) {
  const n = new Napkin(opts.vault || process.cwd());

  if (!opts.key) {
    error("Usage: napkin config get --key <path>");
    process.exit(EXIT_USER_ERROR);
  }

  const value = n.configGet(opts.key);

  output(opts, {
    json: () => ({ key: opts.key, value }),
    human: () => {
      if (value === undefined) {
        console.log(dim("(not set)"));
      } else {
        console.log(
          typeof value === "object"
            ? JSON.stringify(value, null, 2)
            : String(value),
        );
      }
    },
  });
}
