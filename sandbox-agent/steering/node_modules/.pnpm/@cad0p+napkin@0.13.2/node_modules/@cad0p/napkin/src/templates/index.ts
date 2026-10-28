import type { VaultTemplate } from "./types.js";

export type { VaultTemplate };

import { coding } from "./coding.js";
import { company } from "./company.js";
import { personal } from "./personal.js";
import { product } from "./product.js";
import { research } from "./research.js";

export const TEMPLATES: Record<string, VaultTemplate> = {
  coding,
  personal,
  research,
  company,
  product,
};

export function registerTemplate(template: VaultTemplate): void {
  TEMPLATES[template.name] = template;
}
