import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/compat";
import { APP_NAME } from "../config.js";
process.title = APP_NAME;
process.emitWarning = (() => { });
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
//# sourceMappingURL=runtime-setup.js.map