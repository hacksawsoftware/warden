# Warden

A JavaScript Monorepo Script Runner

![demo gif](https://github.com/user-attachments/assets/03a56281-042a-4baa-ba40-37b636b4082f)

> [!WARNING]
> Warden is in early development and may have rapid breaking changes. Try it out, but don't depend on it (yet)

## Overview

If you've worked in a large JavaScript monorepo, you likely find yourself needing to run scripts from a number of monorepo packages in an adhoc manner. You likely open up many terminal windows or slip your way through a complex pnpm --filter call, assuming you even remember all your package names. Warden's goal is to provide a more interactive way to run these scripts within a single terminal window.

## Install

Warden is made to be installed globally.

```shell
npm install -g @hacksaw/warden
```

## Usage

Call warden inside your monorepo. The CLI will auto detect your workspace type and deduce your packages from there.

```
warden
```

> [!IMPORTANT]
> Currently, supported workspaces are npm, pnpm, and yarn
