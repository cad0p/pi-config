import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { listFiles } from "../utils/files.js";
import type { Ignorer } from "../utils/ignore.js";

export interface CanvasNode {
  id: string;
  type: "text" | "file" | "link" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
  color?: string;
  background?: string;
  backgroundStyle?: string;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: string;
  fromEnd?: string;
  toNode: string;
  toSide?: string;
  toEnd?: string;
  color?: string;
  label?: string;
}

export interface Canvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

function genId(): string {
  return crypto.randomBytes(8).toString("hex");
}

export function resolveCanvas(
  vaultPath: string,
  fileRef: string,
  ignore?: Ignorer,
): { canvas: Canvas; filePath: string } {
  let filePath = fileRef;
  if (!filePath.endsWith(".canvas")) filePath = `${filePath}.canvas`;

  const fullPath = path.join(vaultPath, filePath);
  if (!fs.existsSync(fullPath)) {
    const all = listFiles(vaultPath, { ignore }).filter((f) =>
      f.endsWith(".canvas"),
    );
    const target = fileRef.toLowerCase().replace(/\.canvas$/, "");
    const found = all.find(
      (f) => path.basename(f, ".canvas").toLowerCase() === target,
    );
    if (!found) {
      throw new Error(`Canvas not found: ${fileRef}`);
    }
    filePath = found;
  }

  const content = fs.readFileSync(path.join(vaultPath, filePath), "utf-8");
  const canvas: Canvas = JSON.parse(content);
  canvas.nodes = canvas.nodes || [];
  canvas.edges = canvas.edges || [];
  return { canvas, filePath };
}

function writeCanvas(
  vaultPath: string,
  filePath: string,
  canvas: Canvas,
): void {
  fs.writeFileSync(
    path.join(vaultPath, filePath),
    JSON.stringify(canvas, null, 2),
  );
}

export function listCanvases(vaultPath: string, ignore?: Ignorer): string[] {
  return listFiles(vaultPath, { ignore }).filter((f) => f.endsWith(".canvas"));
}

export function createCanvas(
  vaultPath: string,
  fileName: string,
  folder?: string,
): { path: string; created: boolean } {
  const name = fileName.endsWith(".canvas") ? fileName : `${fileName}.canvas`;
  const targetPath = folder ? `${folder}/${name}` : name;
  const fullPath = path.join(vaultPath, targetPath);

  if (fs.existsSync(fullPath)) {
    throw new Error(`Canvas already exists: ${targetPath}`);
  }

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const canvas: Canvas = { nodes: [], edges: [] };
  writeCanvas(vaultPath, targetPath, canvas);

  return { path: targetPath, created: true };
}

export function addCanvasNode(
  vaultPath: string,
  fileRef: string,
  opts: {
    type?: string;
    text?: string;
    noteFile?: string;
    subpath?: string;
    url?: string;
    label?: string;
    x?: string;
    y?: string;
    width?: string;
    height?: string;
    color?: string;
  },
  ignore?: Ignorer,
): { id: string; type: string; added: boolean } {
  const nodeType = (opts.type || "text") as CanvasNode["type"];
  if (!["text", "file", "link", "group"].includes(nodeType)) {
    throw new Error("Invalid node type. Use: text, file, link, or group");
  }

  const { canvas, filePath } = resolveCanvas(vaultPath, fileRef, ignore);

  const maxX = canvas.nodes.reduce((max, n) => Math.max(max, n.x + n.width), 0);

  const node: CanvasNode = {
    id: genId(),
    type: nodeType,
    x: opts.x
      ? Number.parseInt(opts.x, 10)
      : canvas.nodes.length > 0
        ? maxX + 50
        : 0,
    y: opts.y ? Number.parseInt(opts.y, 10) : 0,
    width: opts.width
      ? Number.parseInt(opts.width, 10)
      : nodeType === "group"
        ? 600
        : 300,
    height: opts.height
      ? Number.parseInt(opts.height, 10)
      : nodeType === "group"
        ? 400
        : 150,
  };

  if (nodeType === "text") node.text = opts.text || "";
  if (nodeType === "file") {
    node.file = opts.noteFile || "";
    if (opts.subpath) node.subpath = opts.subpath;
  }
  if (nodeType === "link") node.url = opts.url || "";
  if (nodeType === "group") node.label = opts.label || "";
  if (opts.color) node.color = opts.color;

  canvas.nodes.push(node);
  writeCanvas(vaultPath, filePath, canvas);

  return { id: node.id, type: node.type, added: true };
}

export function addCanvasEdge(
  vaultPath: string,
  fileRef: string,
  opts: {
    from: string;
    to: string;
    fromSide?: string;
    toSide?: string;
    label?: string;
    color?: string;
  },
  ignore?: Ignorer,
): { id: string; from: string; to: string; added: boolean } {
  const { canvas, filePath } = resolveCanvas(vaultPath, fileRef, ignore);

  const findNode = (ref: string) =>
    canvas.nodes.find((n) => n.id === ref || n.id.startsWith(ref));

  const fromNode = findNode(opts.from);
  const toNode = findNode(opts.to);
  if (!fromNode) throw new Error(`Node not found: ${opts.from}`);
  if (!toNode) throw new Error(`Node not found: ${opts.to}`);

  const edge: CanvasEdge = {
    id: genId(),
    fromNode: fromNode.id,
    toNode: toNode.id,
  };

  if (opts.fromSide) edge.fromSide = opts.fromSide;
  if (opts.toSide) edge.toSide = opts.toSide;
  if (opts.label) edge.label = opts.label;
  if (opts.color) edge.color = opts.color;

  canvas.edges.push(edge);
  writeCanvas(vaultPath, filePath, canvas);

  return { id: edge.id, from: edge.fromNode, to: edge.toNode, added: true };
}

export function removeCanvasNode(
  vaultPath: string,
  fileRef: string,
  nodeId: string,
  ignore?: Ignorer,
): { id: string; removed: boolean } {
  const { canvas, filePath } = resolveCanvas(vaultPath, fileRef, ignore);

  const node = canvas.nodes.find(
    (n) => n.id === nodeId || n.id.startsWith(nodeId),
  );
  if (!node) throw new Error(`Node not found: ${nodeId}`);

  canvas.nodes = canvas.nodes.filter((n) => n.id !== node.id);
  canvas.edges = canvas.edges.filter(
    (e) => e.fromNode !== node.id && e.toNode !== node.id,
  );
  writeCanvas(vaultPath, filePath, canvas);

  return { id: node.id, removed: true };
}
