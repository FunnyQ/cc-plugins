export declare function initDesignSystem(rootEl: unknown): {
  load(project: string): Promise<void>;
  probe(project: string): Promise<boolean>;
} | null;
