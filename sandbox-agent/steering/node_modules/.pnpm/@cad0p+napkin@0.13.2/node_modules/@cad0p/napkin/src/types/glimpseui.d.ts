declare module "glimpseui" {
  interface GlimpseWindow {
    on(event: "message", cb: (data: Record<string, unknown>) => void): void;
    on(event: "closed", cb: () => void): void;
    on(event: "ready", cb: () => void): void;
    on(event: "error", cb: (err: Error) => void): void;
    close(): void;
  }

  interface OpenOptions {
    width?: number;
    height?: number;
    title?: string;
    floating?: boolean;
  }

  export function open(html: string, options?: OpenOptions): GlimpseWindow;
}
