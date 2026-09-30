export declare const SEMANTIC_NODES: Record<string, { stroke: string; fill: string }>;
export declare const NIGHT_FLIGHT_THEME: { darkMode: boolean } & Record<string, string>;
export declare function openDiagramLightbox(svg: string, title?: string): void;
export declare function closeDiagramLightbox(): void;
export declare function renderDiagram(text: string): Promise<
  { ok: true; svg: string } | { ok: false; error: string }
>;
