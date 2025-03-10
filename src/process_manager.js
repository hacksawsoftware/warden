import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

import chalk from "chalk";
import * as p from "@clack/prompts";
import Table from "cli-table3";
import { globby } from "globby";
import yaml from "yaml";

/**
 * @typedef {Object} WorkspaceProject
 * @property {string} name - Name of the project
 * @property {string} path - Filesystem path to the project
 * @property {Object} packageJson - Package.json contents
 * @property {Record<string, string>} packageJson.scripts - Available npm scripts
 */

export class WorkspaceProcessManager {
	/** @type {WorkspaceProject[]} */
	#workspaceProjects = [];

	/** @type {Map<string, import('node:child_process').ChildProcessWithoutNullStreams>} */
	#runningProcesses = new Map();

	/** @type {'npm' | 'pnpm' | 'yarn'} */
	#packageManager = "npm";

	/** @param {string} rootDir */
	constructor(rootDir) {
		this.rootDir = rootDir;
	}

	/** @returns {Promise<string | undefined>} */
	async detectWorkspaceProjects() {
		let message;
		try {
			const pnpmWorkspaceFile = path.join(this.rootDir, "pnpm-workspace.yaml");
			const packageJsonPath = path.join(this.rootDir, "package.json");
			const yarnLockPath = path.join(this.rootDir, "yarn.lock");
			const pnpmLockPath = path.join(this.rootDir, "pnpm-lock.yaml");

			// Detect package manager
			if (fs.existsSync(pnpmWorkspaceFile) || fs.existsSync(pnpmLockPath)) {
				this.#packageManager = "pnpm";
				message = "Detected pnpm workspace";
			} else if (fs.existsSync(yarnLockPath)) {
				this.#packageManager = "yarn";
				message = "Detected yarn workspace";
			} else {
				this.#packageManager = "npm";
				message = "Defaulting to npm workspace";
			}

			// Detect workspace projects
			if (fs.existsSync(pnpmWorkspaceFile)) {
				await this.#detectPnpmProjects();
			}

			if (fs.existsSync(packageJsonPath)) {
				const packageJson = JSON.parse(
					fs.readFileSync(packageJsonPath, "utf-8"),
				);
				if (packageJson.workspaces) {
					await this.#detectNpmProjects(packageJson.workspaces);
				}

				return message;
			}
		} catch (error) {
			p.log.error(`Error detecting workspace projects: ${error}`);
		}
		return undefined;
	}

	/** @private */
	async #detectPnpmProjects() {
		const pnpmWorkspaceConfig = fs.readFileSync(
			path.join(this.rootDir, "pnpm-workspace.yaml"),
			"utf-8",
		);

		const config = yaml.parse(pnpmWorkspaceConfig);

		if (config.packages) {
			for (const pattern of config.packages) {
				const matchingDirs = await globby(pattern, {
					cwd: this.rootDir,
					onlyDirectories: true,
					absolute: true,
				});
				for (const dir of matchingDirs) {
					this.#scanProjectsInDirectory(dir);
				}
			}
		}
	}

	/**
	 * @private
	 * @param {string[]} workspacePatterns
	 */
	async #detectNpmProjects(workspacePatterns) {
		for (const pattern of workspacePatterns) {
			const matchingDirs = await globby([pattern], {
				cwd: this.rootDir,
				absolute: true,
				onlyDirectories: true,
			});
			for (const dir of matchingDirs) {
				this.#scanProjectsInDirectory(dir);
			}
		}
	}

	/**
	 * @private
	 * @param {string} directory
	 */
	#scanProjectsInDirectory(directory) {
		const packageJsonPath = path.join(directory, "package.json");

		if (fs.existsSync(packageJsonPath)) {
			try {
				const packageJson = JSON.parse(
					fs.readFileSync(packageJsonPath, "utf-8"),
				);

				this.#workspaceProjects.push({
					name: packageJson.name,
					path: directory,
					packageJson: {
						scripts: packageJson.scripts || {},
					},
				});
			} catch (error) {
				console.error(chalk.red(`Error processing ${directory}:`), error);
			}
		}
	}

	/** @returns {WorkspaceProject[]} */
	getWorkspaceProjects() {
		return this.#workspaceProjects;
	}

	/** @returns {Record<string, WorkspaceProject[]>} */
	getAllAvailableScripts() {
		const scriptMap = {};

		for (const project of this.#workspaceProjects) {
			for (const scriptName of Object.keys(project.packageJson.scripts)) {
				if (!scriptMap[scriptName]) {
					scriptMap[scriptName] = [];
				}
				scriptMap[scriptName].push(project);
			}
		}

		return scriptMap;
	}

	/**
	 * @param {string} scriptName
	 * @param {WorkspaceProject[]} projects
	 */
	runScript(scriptName, projects) {
		for (const project of projects) {
			const processKey = `${project.name}:${scriptName}`;

			p.log.info(`Running ${processKey} with ${this.#packageManager}`);

			// Use the detected package manager
			const childProcess = spawn(this.#packageManager, ["run", scriptName], {
				cwd: project.path,
				// Use pipe instead of inherit to have more control over stdio
				stdio: ["pipe", "pipe", "pipe"],
				// Always use detached to ensure process groups on all platforms
				detached: true,
			});

			// Pipe the child process stdio to parent process
			if (childProcess.stdout) childProcess.stdout.pipe(process.stdout);
			if (childProcess.stderr) childProcess.stderr.pipe(process.stderr);
			if (childProcess.stdin) process.stdin.pipe(childProcess.stdin);

			this.#runningProcesses.set(processKey, childProcess);

			// Handle both close and exit events
			childProcess.on("close", (code) => {
				console.log(
					code === 0
						? chalk.green(`Process ${processKey} completed successfully`)
						: chalk.red(`Process ${processKey} exited with code ${code}`),
				);
				this.#runningProcesses.delete(processKey);
			});

			// Also handle error events to prevent uncaught exceptions
			childProcess.on("error", (err) => {
				console.error(chalk.red(`Process ${processKey} error:`), err);
				this.#runningProcesses.delete(processKey);
			});
		}
	}

	async stopAllProcesses() {
		const processes = [...this.#runningProcesses.entries()];
		if (processes.length === 0) {
			return;
		}

		console.log(
			chalk.yellow(`Stopping ${processes.length} running processes...`),
		);

		// Create a promise that resolves when all processes are terminated
		const terminationPromises = [];

		for (const [key, childProcess] of processes) {
			console.log(chalk.yellow(`Stopping process: ${key}`));

			const terminationPromise = new Promise((resolve) => {
				try {
					// Clean up stdio pipes first to prevent write-after-end errors
					if (childProcess.stdout) {
						childProcess.stdout.unpipe(process.stdout);
						childProcess.stdout.destroy();
					}
					if (childProcess.stderr) {
						childProcess.stderr.unpipe(process.stderr);
						childProcess.stderr.destroy();
					}
					if (childProcess.stdin) {
						process.stdin.unpipe(childProcess.stdin);
						childProcess.stdin.end();
					}

					// Set up listeners to know when the process is actually terminated
					const onExit = () => {
						this.#runningProcesses.delete(key);
						childProcess.removeAllListeners();
						resolve();
					};

					childProcess.once("close", onExit);
					childProcess.once("exit", onExit);

					// Kill the process or process group
					if (process.platform !== "win32" && childProcess.pid) {
						try {
							// On Unix, negative PID kills the process group
							process.kill(-childProcess.pid, "SIGTERM");
						} catch (e) {
							// If process group kill fails, try direct kill
							try {
								childProcess.kill("SIGTERM");
							} catch (err) {
								// Process might already be gone
								onExit();
							}
						}
					} else if (childProcess.pid) {
						// On Windows, use tree-kill or similar approach
						try {
							// Windows doesn't support process groups the same way
							// so we use the regular kill and rely on the parent-child relationship
							childProcess.kill("SIGTERM");
						} catch (err) {
							// Process might already be gone
							onExit();
						}
					} else {
						// No PID, process might already be gone
						onExit();
					}

					// Force kill after timeout
					setTimeout(() => {
						if (this.#runningProcesses.has(key)) {
							console.log(chalk.yellow(`Force killing process: ${key}`));
							try {
								if (process.platform !== "win32" && childProcess.pid) {
									process.kill(-childProcess.pid, "SIGKILL");
								} else if (childProcess.pid) {
									childProcess.kill("SIGKILL");
								}
							} catch (e) {
								// Process might have exited just before this
								console.log(chalk.gray(`Process ${key} already exited`));
							} finally {
								// Ensure we resolve the promise even if kill fails
								onExit();
							}
						}
					}, 2000);
				} catch (error) {
					console.error(chalk.red(`Error stopping process ${key}:`), error);
					this.#runningProcesses.delete(key);
					resolve();
				}
			});

			terminationPromises.push(terminationPromise);
		}

		// Return a promise that resolves when all processes are terminated
		return Promise.all(terminationPromises).then(() => {
			console.log(chalk.green("All processes terminated"));
		});
	}

	async interactiveMenu() {
		while (true) {
			const action = await p.select({
				message: "Choose an action",
				options: [
					{ value: "run-scripts", label: "Run Scripts" },
					{ value: "list-projects", label: "List Projects" },
					{ value: "list-scripts", label: "List Available Scripts" },
					{ value: "stop-processes", label: "Stop All Processes" },
					{ value: "exit", label: "Exit" },
				],
			});

			if (p.isCancel(action)) {
				this.#handleCancel();
				return;
			}

			switch (action) {
				case "list-projects":
					this.#displayProjects();
					break;
				case "list-scripts":
					this.#displayAvailableScripts();
					break;
				case "run-scripts":
					await this.#runScriptsInteractively();
					break;
				case "stop-processes":
					this.stopAllProcesses();
					break;
				case "exit":
					this.#handleGoodbye();
					return;
			}

			const shouldContinue = await p.confirm({ message: "Continue?" });
			if (p.isCancel(shouldContinue) || !shouldContinue) {
				this.#handleGoodbye();
				return;
			}
		}
	}

	/** @private */
	#displayProjects() {
		const table = new Table({
			head: [chalk.blue("Project Name"), chalk.blue("Path")],
		});

		for (const project of this.#workspaceProjects) {
			table.push([project.name, project.path]);
		}

		console.log(table.toString());
	}

	/** @private */
	#displayAvailableScripts() {
		const availableScripts = this.getAllAvailableScripts();

		const table = new Table({
			head: [chalk.blue("Script Name"), chalk.blue("Projects")],
		});

		for (const [scriptName, projects] of Object.entries(availableScripts)) {
			table.push([scriptName, projects.map((p) => p.name).join(", ")]);
		}

		console.log(table.toString());
	}

	#handleCancel() {
		this.stopAllProcesses();
		p.cancel("Operation cancelled");
		process.exit(0);
	}

	#handleGoodbye() {
		this.stopAllProcesses();
		p.outro(chalk.green("Goodbye!"));
		process.exit(0);
	}

	async #runScriptsInteractively() {
		// First, select the projects to work with
		const selectedProjects = await p.multiselect({
			message: "Select projects to run scripts in",
			options: this.#workspaceProjects.map((project) => ({
				value: project,
				label: project.name,
			})),
		});

		if (p.isCancel(selectedProjects)) {
			this.#handleCancel();
			return;
		}

		// Collect all script selections before running anything
		const projectScriptSelections = [];

		// For each selected project, choose which scripts to run
		for (const project of selectedProjects) {
			const availableScripts = Object.keys(project.packageJson.scripts);

			if (availableScripts.length === 0) {
				p.log.warning(`No scripts available in ${project.name}`);
				continue;
			}

			const selectedScripts = await p.multiselect({
				message: `Select scripts to run in ${chalk.cyan(project.name)}`,
				options: availableScripts.map((scriptName) => ({
					value: scriptName,
					label: `${scriptName}: ${project.packageJson.scripts[scriptName]}`,
				})),
			});

			if (p.isCancel(selectedScripts)) {
				this.#handleCancel();
				return;
			}

			if (selectedScripts.length > 0) {
				projectScriptSelections.push({
					project,
					scripts: selectedScripts,
				});
			}
		}

		// Now run all selected scripts
		for (const { project, scripts } of projectScriptSelections) {
			for (const scriptName of scripts) {
				this.runScript(scriptName, [project]);
			}
		}
	}
}
