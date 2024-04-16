import log from "@/next/log";
import { validateAndGetCreationUnixTimeInMicroSeconds } from "@ente/shared/time";
import type { FixOption } from "components/FixCreationTime";
import { FILE_TYPE } from "constants/file";
import { getFileType } from "services/typeDetectionService";
import { EnteFile } from "types/file";
import {
    changeFileCreationTime,
    updateExistingFilePubMetadata,
} from "utils/file";
import downloadManager from "./download";
import { getParsedExifData } from "./upload/exifService";

const EXIF_TIME_TAGS = [
    "DateTimeOriginal",
    "CreateDate",
    "ModifyDate",
    "DateCreated",
    "MetadataDate",
];

export type SetProgressTracker = React.Dispatch<
    React.SetStateAction<{
        current: number;
        total: number;
    }>
>;

export async function updateCreationTimeWithExif(
    filesToBeUpdated: EnteFile[],
    fixOption: FixOption,
    customTime: Date,
    setProgressTracker: SetProgressTracker,
) {
    let completedWithError = false;
    try {
        if (filesToBeUpdated.length === 0) {
            return completedWithError;
        }
        setProgressTracker({ current: 0, total: filesToBeUpdated.length });
        for (const [index, file] of filesToBeUpdated.entries()) {
            try {
                let correctCreationTime: number;
                if (fixOption === "custom-time") {
                    correctCreationTime = customTime.getTime() * 1000;
                } else {
                    if (file.metadata.fileType !== FILE_TYPE.IMAGE) {
                        continue;
                    }
                    const fileStream = await downloadManager.getFile(file);
                    const fileBlob = await new Response(fileStream).blob();
                    const fileObject = new File(
                        [fileBlob],
                        file.metadata.title,
                    );
                    const fileTypeInfo = await getFileType(fileObject);
                    const exifData = await getParsedExifData(
                        fileObject,
                        fileTypeInfo,
                        EXIF_TIME_TAGS,
                    );
                    if (fixOption === "date-time-original") {
                        correctCreationTime =
                            validateAndGetCreationUnixTimeInMicroSeconds(
                                exifData?.DateTimeOriginal ??
                                    exifData?.DateCreated,
                            );
                    } else if (fixOption === "date-time-digitized") {
                        correctCreationTime =
                            validateAndGetCreationUnixTimeInMicroSeconds(
                                exifData?.CreateDate,
                            );
                    } else if (fixOption === "metadata-date") {
                        correctCreationTime =
                            validateAndGetCreationUnixTimeInMicroSeconds(
                                exifData?.MetadataDate,
                            );
                    }
                }
                if (
                    correctCreationTime &&
                    correctCreationTime !== file.metadata.creationTime
                ) {
                    const updatedFile = await changeFileCreationTime(
                        file,
                        correctCreationTime,
                    );
                    updateExistingFilePubMetadata(file, updatedFile);
                }
            } catch (e) {
                log.error("failed to updated a CreationTime With Exif", e);
                completedWithError = true;
            } finally {
                setProgressTracker({
                    current: index + 1,
                    total: filesToBeUpdated.length,
                });
            }
        }
    } catch (e) {
        log.error("update CreationTime With Exif failed", e);
        completedWithError = true;
    }
    return completedWithError;
}
