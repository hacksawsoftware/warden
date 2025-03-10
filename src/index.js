#!/usr/bin/env node

import process from "node:process";
import chalk from "chalk";
import ora from "ora";
import { WorkspaceProcessManager } from "./process_manager.js";

async function intro() {
	console.log(
		chalk.cyan(`

 █     █░ ▄▄▄       ██▀███  ▓█████▄ ▓█████  ███▄    █ 
▓█░ █ ░█░▒████▄    ▓██ ▒ ██▒▒██▀ ██▌▓█   ▀  ██ ▀█   █ 
▒█░ █ ░█ ▒██  ▀█▄  ▓██ ░▄█ ▒░██   █▌▒███   ▓██  ▀█ ██▒
░█░ █ ░█ ░██▄▄▄▄██ ▒██▀▀█▄  ░▓█▄   ▌▒▓█  ▄ ▓██▒  ▐▌██▒
░░██▒██▓  ▓█   ▓██▒░██▓ ▒██▒░▒████▓ ░▒████▒▒██░   ▓██░
░ ▓░▒ ▒   ▒▒   ▓▒█░░ ▒▓ ░▒▓░ ▒▒▓  ▒ ░░ ▒░ ░░ ▒░   ▒ ▒ 
  ▒ ░ ░    ▒   ▒▒ ░  ░▒ ░ ▒░ ░ ▒  ▒  ░ ░  ░░ ░░   ░ ▒░
  ░   ░    ░   ▒     ░░   ░  ░ ░  ░    ░      ░   ░ ░ 
    ░          ░  ░   ░        ░       ░  ░         ░ 
                             ░                        
`),
	);
	console.log(chalk.gray("  Monorepo Script Runner\n"));
	console.log(
		chalk.yellow("  Warden is in early development; use at your discretion\n"),
	);
}

async function main() {
	await intro();
	const spinner = ora("Detecting workspace projects...").start();
	let processManager;

	try {
		processManager = new WorkspaceProcessManager(process.cwd());
		const message = await processManager.detectWorkspaceProjects();

		if (message) spinner.succeed(message);

		// Handle Ctrl+C
		process.on("SIGINT", async () => {
			console.log(chalk.yellow("\nReceived SIGINT (Ctrl+C). Cleaning up..."));
			if (processManager) {
				// Wait for all processes to be terminated before exiting
				await processManager.stopAllProcesses();
				console.log(chalk.green("Cleanup complete. Exiting..."));
			}
			// Give a small delay to ensure all console output is flushed
			setTimeout(() => {
				process.exit(0);
			}, 100);
		});

		await processManager.interactiveMenu();
	} catch (error) {
		spinner.fail("Failed to initialize workspace process manager");
		console.error(chalk.red(error));
		if (processManager) {
			processManager.stopAllProcesses();
		}
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(chalk.red("Unhandled error:"), error);
	process.exit(1);
});
