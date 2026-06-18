import { toast } from "@/lib/ui/toast";

/** Whether a clipboard/drop item is an image we should upload. */
export function isImageFile(file: File | Blob): boolean {
	return file.type.startsWith("image/");
}

type UploadImageArgs = {
	file: File | Blob;
	/** Bound Convex mutation returning a signed upload URL. */
	generateUploadUrl: () => Promise<string>;
	/** Resolve a stored file id to a servable URL. */
	resolveUrl: (storageId: string) => Promise<string | null>;
};

/**
 * Upload an image blob to Convex file storage via the signed-upload-URL pattern
 * and return a servable URL + a derived alt text. The bytes go straight to the
 * upload URL (POST) — never through a mutation arg (the ~1 MiB ceiling is why
 * images use storage at all, overview §8). Errors surface a toast and rethrow so
 * the caller can fall through to default paste behavior.
 */
export async function uploadImage(
	args: UploadImageArgs,
): Promise<{ url: string; alt: string }> {
	try {
		const postUrl = await args.generateUploadUrl();
		const res = await fetch(postUrl, {
			method: "POST",
			headers: {
				"Content-Type": args.file.type || "application/octet-stream",
			},
			body: args.file,
		});
		if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
		const { storageId } = (await res.json()) as { storageId: string };
		const url = await args.resolveUrl(storageId);
		if (!url) throw new Error("Could not resolve uploaded image URL");
		const alt =
			args.file instanceof File
				? args.file.name.replace(/\.[^.]+$/, "")
				: "image";
		return { url, alt };
	} catch (error) {
		toast("Image upload failed", "error");
		throw error;
	}
}
