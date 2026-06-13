#!/usr/bin/env bun

const COMMANDS = {
  ship() {
    // Walking skeleton: the real Run/Pipeline lands in a later spec.
    console.log("Hello World");
  },
} as const;

function main(argv: string[]): number {
  const [command] = argv;
  if (command && command in COMMANDS) {
    COMMANDS[command as keyof typeof COMMANDS]();
    return 0;
  }
  console.error(`Unknown command: ${command ?? "(none)"}. Try: tml ship`);
  return 1;
}

process.exit(main(process.argv.slice(2)));
