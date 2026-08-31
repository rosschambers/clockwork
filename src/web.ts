import path from "node:path"
import fs from "node:fs"

export type StaticHandler = (req: Request) => Response | undefined

const extMap: Record<string, string> = {
	".html": "text/html",
	".css": "text/css",
	".js": "application/javascript",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".webp": "image/webp",
	".txt": "text/plain",
}

export function serveStatic(dir: string): StaticHandler {
	return function (req: Request): Response | undefined {
		const url = new URL(req.url)
		let filePath = path.join(dir, url.pathname)

		// If path is a directory or ends with /, serve index.html
		if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
			filePath = path.join(filePath, "index.html")
		}

		if (!fs.existsSync(filePath)) {
			return undefined
		}

		const ext = path.extname(filePath).toLowerCase()
		const contentType = extMap[ext] || "application/octet-stream"

		const data = fs.readFileSync(filePath)

		return new Response(data, {
			status: 200,
			headers: { "Content-Type": contentType },
		})
	}
}
