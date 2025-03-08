import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

import chalk from 'chalk';
import * as p from '@clack/prompts';
import Table from 'cli-table3';
import { globby } from 'globby';
import yaml from 'yaml';

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

  /** @param {string} rootDir */
  constructor(rootDir) {
    this.rootDir = rootDir;
  }

  async detectWorkspaceProjects() {
    try {
      const pnpmWorkspaceFile = path.join(this.rootDir, 'pnpm-workspace.yaml');
      const packageJsonPath = path.join(this.rootDir, 'package.json');

      if (fs.existsSync(pnpmWorkspaceFile)) {
        await this.#detectPnpmProjects();
      }

      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        if (packageJson.workspaces) {
          await this.#detectNpmProjects(packageJson.workspaces);
        }
      }
    } catch (error) {
      p.log.error('Error detecting workspace projects:' + error);
    }
  }

  /** @private */
  async #detectPnpmProjects() {
    const pnpmWorkspaceConfig = fs.readFileSync(
      path.join(this.rootDir, 'pnpm-workspace.yaml'), 
      'utf-8'
    );
    
    const config = yaml.parse(pnpmWorkspaceConfig);
    
    if (config.packages) {
      for (const pattern of config.packages) {
        const matchingDirs = await globby(pattern, { 
          cwd: this.rootDir,
          onlyDirectories: true,
          absolute: true
        });
        matchingDirs.forEach(dir => this.#scanProjectsInDirectory(dir));
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
        onlyDirectories: true 
      });
      matchingDirs.forEach(dir => this.#scanProjectsInDirectory(dir));
    }
  }

  /** 
   * @private
   * @param {string} directory 
   */
  #scanProjectsInDirectory(directory) {
    const packageJsonPath = path.join(directory, 'package.json');
    
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        
        this.#workspaceProjects.push({
          name: packageJson.name,
          path: directory,
          packageJson: {
            scripts: packageJson.scripts || {}
          }
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

    this.#workspaceProjects.forEach(project => {
      Object.keys(project.packageJson.scripts).forEach(scriptName => {
        if (!scriptMap[scriptName]) {
          scriptMap[scriptName] = [];
        }
        scriptMap[scriptName].push(project);
      });
    });

    return scriptMap;
  }

  /** 
   * @param {string} scriptName 
   * @param {WorkspaceProject[]} projects 
   */
  runScript(scriptName, projects) {
    projects.forEach(project => {
      const processKey = `${project.name}:${scriptName}`;
      
      p.log.info(`Running ${processKey}`);
      
      const process = spawn('npm', ['run', scriptName], {
        cwd: project.path,
        stdio: 'inherit'
      });

      this.#runningProcesses.set(processKey, process);

      process.on('close', (code) => {
        console.log(
          code === 0 
            ? chalk.green(`Process ${processKey} completed successfully`) 
            : chalk.red(`Process ${processKey} exited with code ${code}`)
        );
        this.#runningProcesses.delete(processKey);
      });
    });
  }

  stopAllProcesses() {
    this.#runningProcesses.forEach((process, key) => {
      console.log(chalk.yellow(`Stopping process: ${key}`));
      // Force kill with SIGKILL if needed
      try {
        process.kill('SIGTERM');
        // Give it a moment to terminate gracefully
        setTimeout(() => {
          if (process.killed === false) {
            process.kill('SIGKILL');
          }
        }, 500);
      } catch (error) {
        console.error(chalk.red(`Error stopping process ${key}:`), error);
      }
      this.#runningProcesses.delete(key);
    });
  }

  async interactiveMenu() {
    p.intro(chalk.cyan('Workspace Process Manager'));

    while (true) {
      const action = await p.select({
        message: 'Choose an action',
        options: [
          { value: 'list-projects', label: 'List Projects' },
          { value: 'list-scripts', label: 'List Available Scripts' },
          { value: 'run-scripts', label: 'Run Scripts' },
          { value: 'stop-processes', label: 'Stop All Processes' },
          { value: 'exit', label: 'Exit' }
        ]
      });

      if (p.isCancel(action)) {
        this.#handleCancel();
        return;
      }

      switch (action) {
        case 'list-projects':
          this.#displayProjects();
          break;
        case 'list-scripts':
          this.#displayAvailableScripts();
          break;
        case 'run-scripts':
          await this.#runScriptsInteractively();
          break;
        case 'stop-processes':
          this.stopAllProcesses();
          break;
        case 'exit':
          this.#handleGoodbye()
          return;
      }

      const shouldContinue = await p.confirm({ message: 'Continue?' });
      if (p.isCancel(shouldContinue) || !shouldContinue) {
        this.#handleGoodbye()
        return;
      }
    }
  }

  /** @private */
  #displayProjects() {
    const table = new Table({
      head: [chalk.blue('Project Name'), chalk.blue('Path')]
    });

    this.#workspaceProjects.forEach(project => {
      table.push([project.name, project.path]);
    });

    console.log(table.toString());
  }

  /** @private */
  #displayAvailableScripts() {
    const availableScripts = this.getAllAvailableScripts();
    
    const table = new Table({
      head: [chalk.blue('Script Name'), chalk.blue('Projects')]
    });

    Object.entries(availableScripts).forEach(([scriptName, projects]) => {
      table.push([
        scriptName, 
        projects.map(p => p.name).join(', ')
      ]);
    });

    console.log(table.toString());
  }

  #handleCancel() {
    this.stopAllProcesses();
    p.cancel('Operation cancelled');
    process.exit(0);
  }

  #handleGoodbye() {
    this.stopAllProcesses();
    p.outro(chalk.green('Goodbye!'));
    process.exit(0);

  }

  async #runScriptsInteractively() {
    const availableScripts = this.getAllAvailableScripts();
    
    const selectedScripts = await p.multiselect({
      message: 'Select scripts to run',
      options: Object.keys(availableScripts).map(scriptName => ({
        value: scriptName,
        label: `${scriptName} (${availableScripts[scriptName].map(p => p.name).join(', ')})`
      }))
    });

    if (p.isCancel(selectedScripts)) {
      this.#handleCancel();
      return;
    }

    for (const scriptName of selectedScripts) {
      const selectedProjects = await p.multiselect({
        message: `Select projects to run "${scriptName}"`,
        options: availableScripts[scriptName].map(project => ({
          value: project,
          label: project.name
        }))
      });

      if (p.isCancel(selectedProjects)) {
        this.#handleCancel();
        return;
      }

      this.runScript(scriptName, selectedProjects);
    }
  }
}

