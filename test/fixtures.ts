/** A valid YAML file whose aliases exceed the parser's maxAliasCount (100). */
export function aliasBomb(): string {
	const lines = ["a0: &a0 [x, x, x, x, x, x, x, x, x, x]"];
	for (let level = 1; level < 4; level++) {
		const refs = Array.from({ length: 10 }, () => `*a${level - 1}`).join(", ");
		lines.push(`a${level}: &a${level} [${refs}]`);
	}
	lines.push("on: release", "jobs: {}");
	return `${lines.join("\n")}\n`;
}
