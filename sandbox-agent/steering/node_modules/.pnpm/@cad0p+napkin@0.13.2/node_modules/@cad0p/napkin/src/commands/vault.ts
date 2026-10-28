import { formatSize } from "../core/vault.js";
import { Napkin } from "../sdk.js";
import { bold, dim, type OutputOptions, output } from "../utils/output.js";

export async function vault(opts: OutputOptions & { vault?: string }) {
  const n = new Napkin(opts.vault || process.cwd());
  const meta = n.info();

  output(opts, {
    json: () => meta,
    human: () => {
      console.log(`${dim("name")}       ${bold(meta.name)}`);
      console.log(`${dim("path")}       ${meta.path}`);
      console.log(`${dim("files")}      ${meta.files}`);
      console.log(`${dim("folders")}    ${meta.folders}`);
      console.log(`${dim("size")}       ${formatSize(meta.size)}`);
    },
  });
}
