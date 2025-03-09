#!/usr/bin/env node

import process from 'node:process';
import chalk from 'chalk';
import ora from 'ora';
import { WorkspaceProcessManager } from './process_manager.js';

async function intro() {
  console.log(chalk.cyan(`

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
`));
  console.log(chalk.gray('  Monorepo Script Runner'));
  console.log('');
}

async function main() {
  await intro();
  const spinner = ora('Detecting workspace projects...').start();
  let processManager;
  
  try {
    processManager = new WorkspaceProcessManager(process.cwd());
    await processManager.detectWorkspaceProjects();
    
    spinner.succeed('Workspace detected!');
    
    // Handle Ctrl+C
    process.on('SIGINT', () => {
      console.log(chalk.yellow('\nReceived SIGINT (Ctrl+C). Cleaning up...'));
      if (processManager) {
        processManager.stopAllProcesses();
      }
      process.exit(0);
    });
    
    await processManager.interactiveMenu();
  } catch (error) {
    spinner.fail('Failed to initialize workspace process manager');
    console.error(chalk.red(error));
    if (processManager) {
      processManager.stopAllProcesses();
    }
    process.exit(1);
  }
}

// Only run main if this is the main module
  main().catch(error => {
    console.error(chalk.red('Unhandled error:'), error);
    process.exit(1);
  });

