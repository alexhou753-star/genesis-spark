// 仅用于本沙箱（无法安装 @types/node）。真实仓库里有 @types/node，应删除本文件。
declare const require: { main?: unknown };
declare const module: unknown;
declare const process: { exit(code?: number): never; argv: string[] };
declare module 'fs' {
  export function readdirSync(p: string, o: { withFileTypes: true }): Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  export function readFileSync(p: string, enc: 'utf8'): string;
  export function writeFileSync(p: string, d: string): void;
  export function mkdirSync(p: string, o?: { recursive: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(p: string, o?: { recursive: boolean; force: boolean }): void;
}
declare module 'path' {
  export function join(...p: string[]): string;
  export function dirname(p: string): string;
}
declare module 'os' {
  export function tmpdir(): string;
}
