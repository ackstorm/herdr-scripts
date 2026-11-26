// opencode plugin: adds this repository's skills.
//
// OpenCode 2 loads the default export and calls `setup`, which takes each skill
// as data. OpenCode 1 calls `server`, whose `config` hook adds the folder.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skills = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills");

// ponytail: `name` and `description` are read as single-line frontmatter values;
// use a YAML parser if a SKILL.md ever needs more.
function read(dir) {
  const file = path.join(skills, dir, "SKILL.md");
  const [, head, content] = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(fs.readFileSync(file, "utf8"));
  const field = (name) => new RegExp(`^${name}:[ \\t]*(.*)$`, "m").exec(head)?.[1].trim();
  return { id: dir, name: field("name") || dir, description: field("description"), path: file, content };
}

async function setup(ctx) {
  if (!ctx.skill) return;
  const all = fs.readdirSync(skills).map(read);
  await ctx.skill.transform((editor) => {
    for (const skill of all) if (!editor.get(skill.id)) editor.add(skill);
  });
}

export const HerdrScriptsPlugin = async () => ({
  config: async (config) => {
    config.skills = config.skills || {};
    config.skills.paths = config.skills.paths || [];
    if (!config.skills.paths.includes(skills)) config.skills.paths.push(skills);
  },
});

export default { id: "herdr-scripts", setup, server: HerdrScriptsPlugin };
