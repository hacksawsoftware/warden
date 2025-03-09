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

	async detectWorkspaceProjects() {
		try {
			const pnpmWorkspaceFile = path.join(this.rootDir, "pnpm-workspace.yaml");
			const packageJsonPath = path.join(this.rootDir, "package.json");
			const yarnLockPath = path.join(this.rootDir, "yarn.lock");
			const pnpmLockPath = path.join(this.rootDir, "pnpm-lock.yaml");

			// Detect package manager
			if (fs.existsSync(pnpmWorkspaceFile) || fs.existsSync(pnpmLockPath)) {
				this.#packageManager = "pnpm";
				p.log.info("Detected pnpm workspace");
			} else if (fs.existsSync(yarnLockPath)) {
				this.#packageManager = "yarn";
				p.log.info("Detected yarn workspace");
			} else {
				this.#packageManager = "npm";
				p.log.info("Using npm as package manager");
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
			}
		} catch (error) {
			p.log.error(`Error detecting workspace projects: ${error}`);
		}
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
				stdio: "inherit",
				// This ensures the process gets its own process group ID on Unix systems
				detached: process.platform !== "win32",
			});

			// Store a reference to the original stdio streams for cleanup
			childProcess._originalStdio = {
				stdout: childProcess.stdout,
				stderr: childProcess.stderr,
			};

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

	stopAllProcesses() {
		const processes = [...this.#runningProcesses.entries()];

		for (const [key, childProcess] of processes) {
			console.log(chalk.yellow(`Stopping process: ${key}`));

			try {
				// Track if the process has been terminated
				let isTerminated = false;

				// Detach stdio to swallow all output after termination
				if (childProcess.stdout) childProcess.stdout.destroy();
				if (childProcess.stderr) childProcess.stderr.destroy();

				// Set up listeners to know when the process is actually terminated
				const onExit = () => {
					isTerminated = true;
					this.#runningProcesses.delete(key);
					childProcess.removeAllListeners();
				};

				childProcess.once("close", onExit);
				childProcess.once("exit", onExit);

				if (process.platform !== "win32" && childProcess.pid) {
					// On Unix-like systems, kill the entire process group to handle child processes
					try {
						// Kill the process group with SIGTERM
						process.kill(-childProcess.pid, "SIGTERM");
					} catch (e) {
						// If process group kill fails, fall back to regular kill
						childProcess.kill("SIGTERM");
					}
				} else {
					// On Windows or if no pid, use regular kill
					childProcess.kill("SIGTERM");
				}

				// Give it a moment to terminate gracefully, then force kill if needed
				setTimeout(() => {
					if (!isTerminated) {
						try {
							console.log(chalk.yellow(`Force killing process: ${key}`));

							if (process.platform !== "win32" && childProcess.pid) {
								// Kill the process group with SIGKILL
								try {
									process.kill(-childProcess.pid, "SIGKILL");
								} catch (e) {
									// Fall back to regular kill
									childProcess.kill("SIGKILL");
								}
							} else {
								childProcess.kill("SIGKILL");
							}
						} catch (e) {
							// Process might have exited just before this
							console.log(chalk.gray(`Process ${key} already exited`));
						}
					}
				}, 1000);
			} catch (error) {
				console.error(chalk.red(`Error stopping process ${key}:`), error);
				this.#runningProcesses.delete(key);
			}
		}
	}

	async interactiveMenu() {
		p.intro(chalk.cyan("Workspace Process Manager"));

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
