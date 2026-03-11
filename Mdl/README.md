# Liquid Social Downloader

Liquid is a modern, high-performance web platform for downloading media from across the social web (Instagram, YouTube, TikTok, Reddit, Pinterest, etc).

## 📁 Project Structure

This is a Monorepo containing both the Angular frontend and the Node.js backend:

- **/frontend**: Angular 21+ application (SCSS, TypeScript, anime.js)
- **/backend**: Node.js Express server (yt-dlp engine, JSDOM scraper)
- **/package.json**: Root manager with global commands

## 🚀 Getting Started

From the root directory:

### 1. Install Dependencies

```powershell
npm install
npm run install
```

### 2. Development Mode

Starts both the frontend (localhost:4200) and backend (localhost:3000):

```powershell
npm run dev
```

### 3. Individual Commands

- `npm run start:frontend`: Just the Angular app
- `npm run start:backend`: Just the Node server

## 🌐 Deployment

This project is configured for **Railway** using **Nixpacks**.

1.  **Backend Target URL**: Update `frontend/src/proxy.conf.json` with your Railway production URL.
2.  **Root package.json**: The `npm start` command at the root is automatically configured to run the backend for easy hosting.
    `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
