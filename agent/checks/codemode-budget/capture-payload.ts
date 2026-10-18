// Loaded with `pi -e` by check.mjs only — not a regular extension.
// Writes the first provider payload to $CODEMODE_CHECK_DUMP and exits
// before the HTTP call, so the check needs no credentials or network.
import { writeFileSync } from "node:fs";

export default function (pi: any) {
	pi.on("before_provider_request", (event: any) => {
		writeFileSync(process.env.CODEMODE_CHECK_DUMP!, JSON.stringify(event.payload));
		process.exit(0);
	});
}
