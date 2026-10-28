import { Napkin } from "../sdk.js";
import { dim, type OutputOptions, output } from "../utils/output.js";

export async function aliases(
  opts: OutputOptions & {
    vault?: string;
    file?: string;
    total?: boolean;
    verbose?: boolean;
  },
) {
  const n = new Napkin(opts.vault || process.cwd());
  const result = n.aliases(opts.file);

  output(opts, {
    json: () => {
      if (opts.total) return { total: result.length };
      if (opts.verbose) return { aliases: result };
      return { aliases: result.map((r) => r.alias) };
    },
    human: () => {
      if (opts.total) {
        console.log(result.length);
      } else {
        for (const r of result) {
          console.log(opts.verbose ? `${r.alias}\t${dim(r.file)}` : r.alias);
        }
      }
    },
  });
}
