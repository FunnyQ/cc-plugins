export declare function detectType(text: string): string | null;
export declare function parse(text: string): unknown;
export declare function render(
  source: string,
  options?: { fontFamily?: string; fontSize?: number; idPrefix?: string },
): { svg: string; width: number; height: number; type: string };
