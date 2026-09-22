#!/usr/bin/env node
// GAH: must run before config.ts reads the environment (see gah-env.ts).
import "./core/gah-env.ts";
import { setupCli } from "./cli/setup.ts";
import { main } from "./main.ts";

setupCli();
main(process.argv.slice(2));
