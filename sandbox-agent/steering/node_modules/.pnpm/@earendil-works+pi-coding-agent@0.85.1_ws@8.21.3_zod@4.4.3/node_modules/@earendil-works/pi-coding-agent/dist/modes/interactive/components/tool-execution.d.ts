import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Component, Container, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext, ToolRenderResultOptions } from "../../../core/extensions/types.ts";
import type { Theme } from "../theme/theme.ts";
/**
 * What this component needs from a tool: how to draw it. It neither executes tools nor reads their
 * parameter schemas, so a definition and a bare renderer pair are equally acceptable.
 *
 * The renderer parameters are `any` on purpose: a `ToolDefinition` types them from its schema, and
 * narrowing them here would make those definitions unassignable.
 */
export interface ToolRenderers {
    renderShell?: "default" | "self";
    renderCall?: (args: any, theme: Theme, context: ToolRenderContext<any, any>) => Component;
    renderResult?: (result: AgentToolResult<any>, options: ToolRenderResultOptions, theme: Theme, context: ToolRenderContext<any, any>) => Component;
}
export interface ToolExecutionOptions {
    showImages?: boolean;
    imageWidthCells?: number;
}
export declare class ToolExecutionComponent extends Container {
    private contentBox;
    private contentText;
    private contentTextRegion;
    private selfRenderContainer;
    private selfRenderHeight;
    private callRendererComponent?;
    private resultRendererComponent?;
    private rendererState;
    private imageComponents;
    private imageSpacers;
    private toolName;
    private toolCallId;
    private args;
    private expanded;
    private showImages;
    private imageWidthCells;
    private isPartial;
    private toolDefinition?;
    private ui;
    private cwd;
    private executionStarted;
    private argsComplete;
    private result?;
    private convertedImages;
    private hideComponent;
    constructor(toolName: string, toolCallId: string, args: any, options: ToolExecutionOptions | undefined, toolDefinition: ToolRenderers | ToolDefinition<any, any, any> | undefined, ui: TUI, cwd: string);
    private getCallRenderer;
    private getResultRenderer;
    private hasRendererDefinition;
    private getRenderShell;
    private getRenderContext;
    private createCallFallback;
    private createResultFallback;
    private createResultRegion;
    updateArgs(args: any): void;
    markExecutionStarted(): void;
    setArgsComplete(): void;
    updateResult(result: {
        content: Array<{
            type: string;
            text?: string;
            data?: string;
            mimeType?: string;
        }>;
        details?: any;
        isError: boolean;
    }, isPartial?: boolean): void;
    private maybeConvertImagesForKitty;
    setExpanded(expanded: boolean): void;
    setShowImages(show: boolean): void;
    setImageWidthCells(width: number): void;
    invalidate(): void;
    render(width: number): string[];
    handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]>;
    private updateDisplay;
    private getTextOutput;
    private formatToolExecution;
}
//# sourceMappingURL=tool-execution.d.ts.map