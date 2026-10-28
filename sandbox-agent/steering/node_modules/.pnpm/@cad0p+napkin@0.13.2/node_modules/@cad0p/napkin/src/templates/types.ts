export interface VaultTemplate {
  name: string;
  description: string;
  dirs: string[];
  files: Record<string, string>;
  napkinMd: string;
}
