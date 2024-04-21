import { fileNameFromComponents, nameAndExtension } from "@/next/file";
import JSZip from "jszip";

/**
 * An in-memory representation of a live photo.
 */
interface LivePhoto {
    imageFileName: string;
    imageData: Uint8Array;
    videoFileName: string;
    videoData: Uint8Array;
}

/**
 * Convert a binary serialized representation of a live photo to an in-memory
 * {@link LivePhoto}.
 *
 * A live photo is a zip file containing two files - an image and a video. This
 * functions reads that zip file (blob), and return separate bytes (and
 * filenames) for the image and video parts.
 *
 * @param fileName The name of the overall live photo. Both the image and video
 * parts of the decompressed live photo use this as their name, combined with
 * their original extensions.
 *
 * @param zipBlob A blob contained the zipped data (i.e. the binary serialized
 * live photo).
 */
export const decodeLivePhoto = async (
    fileName: string,
    zipBlob: Blob,
): Promise<LivePhoto> => {
    let imageFileName, videoFileName: string | undefined;
    let imageData, videoData: Uint8Array | undefined;

    const [name] = nameAndExtension(fileName);
    const zip = await JSZip.loadAsync(zipBlob, { createFolders: true });

    for (const zipFileName in zip.files) {
        if (zipFileName.startsWith("image")) {
            const [, imageExt] = nameAndExtension(zipFileName);
            imageFileName = fileNameFromComponents([name, imageExt]);
            imageData = await zip.files[zipFileName]?.async("uint8array");
        } else if (zipFileName.startsWith("video")) {
            const [, videoExt] = nameAndExtension(zipFileName);
            videoFileName = fileNameFromComponents([name, videoExt]);
            videoData = await zip.files[zipFileName]?.async("uint8array");
        }
    }

    if (!imageFileName || !imageData)
        throw new Error(
            `Decoded live photo ${fileName} does not have an image`,
        );

    if (!videoFileName || !videoData)
        throw new Error(
            `Decoded live photo ${fileName} does not have an image`,
        );

    return { imageFileName, imageData, videoFileName, videoData };
};

/**
 * Return a binary serialized representation of a live photo.
 *
 * This function takes the (in-memory) image and video data from the
 * {@link livePhoto} object, writes them to a zip file (using the respective
 * filenames), and returns the {@link Uint8Array} that represent the bytes of
 * this zip file.
 *
 * @param livePhoto The in-mem photo to serialized.
 */
export const encodeLivePhoto = async ({
    imageFileName,
    imageData,
    videoFileName,
    videoData,
}: LivePhoto) => {
    const [, imageExt] = nameAndExtension(imageFileName);
    const [, videoExt] = nameAndExtension(videoFileName);

    const zip = new JSZip();
    zip.file(fileNameFromComponents(["image", imageExt]), imageData);
    zip.file(fileNameFromComponents(["video", videoExt]), videoData);
    return await zip.generateAsync({ type: "uint8array" });
};
