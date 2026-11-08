// The one tool list. The toolbar, keymap and labels derive from it.

export type ToolId = "move" | "hand" | "pencil" | "comment";
export interface ToolDef { readonly id: ToolId; readonly key: string; readonly label: string; readonly available: (c: { comments: boolean }) => boolean }

export const TOOLS: readonly ToolDef[] = [
  { id: "move", key: "v", label: "Move", available: () => true },
  { id: "hand", key: "h", label: "Hand", available: () => true },
  { id: "comment", key: "c", label: "Comment", available: (c) => c.comments },
  { id: "pencil", key: "p", label: "Pencil", available: () => true },
];

export const PENCIL_COLORS = [
  { name: "Black", hex: "#1a1a1a" }, { name: "Red", hex: "#e5484d" }, { name: "Blue", hex: "#2563eb" },
  { name: "Green", hex: "#16a34a" }, { name: "Purple", hex: "#7c3aed" }, { name: "White", hex: "#ffffff" },
] as const;
export const PENCIL_SIZES = [3, 6, 12, 22] as const;
export type PencilSize = (typeof PENCIL_SIZES)[number];
// Annotation ink must remain visible on white snapshots as well as the canvas.
export const defaultInk = (_theme: "light" | "dark"): string => "#2563eb";
