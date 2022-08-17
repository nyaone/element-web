const { writeFileSync, existsSync, mkdirSync } = require("fs");
const { version } = require("./package.json");

if (!existsSync("./webapp")) {
    mkdirSync("./webapp");
}
writeFileSync("./webapp/version", version);
