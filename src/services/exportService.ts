import { runningInBrowser } from 'utils/common';
import {
    getExportPendingFiles,
    getExportFailedFiles,
    getFilesUploadedAfterLastExport,
    dedupe,
    getGoogleLikeMetadataFile,
    getExportRecordFileUID,
    getUniqueCollectionFolderPath,
    getUniqueFileSaveName,
} from 'utils/export';
import { retryAsyncFunction } from 'utils/network';
import { logError } from 'utils/sentry';
import { getData, LS_KEYS } from 'utils/storage/localStorage';
import {
    Collection,
    getLocalCollections,
    getNonEmptyCollections,
} from './collectionService';
import downloadManager from './downloadManager';
import { File, FILE_TYPE, getLocalFiles } from './fileService';
import { decodeMotionPhoto } from './motionPhotoService';
import {
    fileNameWithoutExtension,
    generateStreamFromArrayBuffer,
    getFileExtension,
    mergeMetadata,
    TYPE_JPEG,
    TYPE_JPG,
} from 'utils/file';
import { User } from './userService';
import { updateFileModifyDateInEXIF } from './upload/exifService';

export interface ExportProgress {
    current: number;
    total: number;
}
export interface ExportStats {
    failed: number;
    success: number;
}

export interface ExportRecord {
    stage: ExportStage;
    lastAttemptTimestamp: number;
    progress: ExportProgress;
    queuedFiles: string[];
    exportedFiles: string[];
    failedFiles: string[];
}
export enum ExportStage {
    INIT,
    INPROGRESS,
    PAUSED,
    FINISHED,
}

enum ExportNotification {
    START = 'export started',
    IN_PROGRESS = 'export already in progress',
    FINISH = 'export finished',
    FAILED = 'export failed',
    ABORT = 'export aborted',
    PAUSE = 'export paused',
    UP_TO_DATE = `no new files to export`,
}

enum RecordType {
    SUCCESS = 'success',
    FAILED = 'failed',
}
export enum ExportType {
    NEW,
    PENDING,
    RETRY_FAILED,
}

const EXPORT_RECORD_FILE_NAME = 'export_status.json';
export const METADATA_FOLDER_NAME = 'metadata';

class ExportService {
    ElectronAPIs: any;

    private exportInProgress: Promise<{ paused: boolean }> = null;
    private recordUpdateInProgress = Promise.resolve();
    private stopExport: boolean = false;
    private pauseExport: boolean = false;
    private usedFilenames = new Map<number, Set<string>>();

    constructor() {
        this.ElectronAPIs = runningInBrowser() && window['ElectronAPIs'];
    }
    async selectExportDirectory() {
        return await this.ElectronAPIs.selectRootDirectory();
    }
    stopRunningExport() {
        this.stopExport = true;
    }
    pauseRunningExport() {
        this.pauseExport = true;
    }
    async exportFiles(
        updateProgress: (progress: ExportProgress) => void,
        exportType: ExportType
    ) {
        try {
            if (this.exportInProgress) {
                this.ElectronAPIs.sendNotification(
                    ExportNotification.IN_PROGRESS
                );
                return await this.exportInProgress;
            }
            this.ElectronAPIs.showOnTray('starting export');
            const exportDir = getData(LS_KEYS.EXPORT)?.folder;
            if (!exportDir) {
                // no-export folder set
                return;
            }
            let filesToExport: File[];
            const allFiles = await getLocalFiles();
            const collections = await getLocalCollections();
            const nonEmptyCollections = getNonEmptyCollections(
                collections,
                allFiles
            );
            const user: User = getData(LS_KEYS.USER);
            const userCollections = nonEmptyCollections.filter(
                (collection) => collection.owner.id === user?.id
            );
            const exportRecord = await this.getExportRecord(exportDir);

            if (exportType === ExportType.NEW) {
                filesToExport = await getFilesUploadedAfterLastExport(
                    allFiles,
                    exportRecord
                );
            } else if (exportType === ExportType.RETRY_FAILED) {
                filesToExport = await getExportFailedFiles(
                    allFiles,
                    exportRecord
                );
            } else {
                filesToExport = await getExportPendingFiles(
                    allFiles,
                    exportRecord
                );
            }
            this.exportInProgress = this.fileExporter(
                filesToExport,
                userCollections,
                updateProgress,
                exportDir
            );
            const resp = await this.exportInProgress;
            this.exportInProgress = null;
            return resp;
        } catch (e) {
            logError(e, 'exportFiles failed');
            return { paused: false };
        }
    }

    async fileExporter(
        files: File[],
        collections: Collection[],
        updateProgress: (progress: ExportProgress) => void,
        dir: string
    ): Promise<{ paused: boolean }> {
        try {
            if (!files?.length) {
                this.ElectronAPIs.sendNotification(
                    ExportNotification.UP_TO_DATE
                );
                return { paused: false };
            }
            this.stopExport = false;
            this.pauseExport = false;
            this.addFilesQueuedRecord(dir, files);
            const failedFileCount = 0;

            this.ElectronAPIs.showOnTray({
                export_progress: `0 / ${files.length} files exported`,
            });
            updateProgress({
                current: 0,
                total: files.length,
            });
            this.ElectronAPIs.sendNotification(ExportNotification.START);
            collections.sort(
                (collectionA, collectionB) => collectionA.id - collectionB.id
            );
            const collectionIDPathMap = new Map<number, string>();
            const usedCollectionPaths = new Set<string>();
            for (const collection of collections) {
                const collectionFolderPath = getUniqueCollectionFolderPath(
                    dir,
                    collection.name,
                    usedCollectionPaths
                );
                usedCollectionPaths.add(collectionFolderPath);
                collectionIDPathMap.set(collection.id, collectionFolderPath);
                await this.ElectronAPIs.checkExistsAndCreateCollectionDir(
                    collectionFolderPath
                );
                await this.ElectronAPIs.checkExistsAndCreateCollectionDir(
                    `${collectionFolderPath}/${METADATA_FOLDER_NAME}`
                );
            }
            files.sort((fileA, fileB) => fileA.id - fileB.id);
            for (const [index, file] of files.entries()) {
                if (this.stopExport || this.pauseExport) {
                    if (this.pauseExport) {
                        this.ElectronAPIs.showOnTray({
                            export_progress: `${index} / ${files.length} files exported (paused)`,
                            paused: true,
                        });
                    }
                    break;
                }
                const collectionPath = collectionIDPathMap.get(
                    file.collectionID
                );
                try {
                    await this.downloadAndSave(file, collectionPath);
                    await this.addFileExportRecord(
                        dir,
                        file,
                        RecordType.SUCCESS
                    );
                } catch (e) {
                    await this.addFileExportRecord(
                        dir,
                        file,
                        RecordType.FAILED
                    );
                    logError(
                        e,
                        'download and save failed for file during export'
                    );
                }
                this.ElectronAPIs.showOnTray({
                    export_progress: `${index + 1} / ${
                        files.length
                    } files exported`,
                });
                updateProgress({ current: index + 1, total: files.length });
            }
            if (this.stopExport) {
                this.ElectronAPIs.sendNotification(ExportNotification.ABORT);
                this.ElectronAPIs.showOnTray();
            } else if (this.pauseExport) {
                this.ElectronAPIs.sendNotification(ExportNotification.PAUSE);
                return { paused: true };
            } else if (failedFileCount > 0) {
                this.ElectronAPIs.sendNotification(ExportNotification.FAILED);
                this.ElectronAPIs.showOnTray({
                    retry_export: `export failed - retry export`,
                });
            } else {
                this.ElectronAPIs.sendNotification(ExportNotification.FINISH);
                this.ElectronAPIs.showOnTray();
            }
            return { paused: false };
        } catch (e) {
            logError(e, 'fileExporter failed');
            throw e;
        }
    }
    async addFilesQueuedRecord(folder: string, files: File[]) {
        const exportRecord = await this.getExportRecord(folder);
        exportRecord.queuedFiles = files.map(getExportRecordFileUID);
        await this.updateExportRecord(exportRecord, folder);
    }

    async addFileExportRecord(folder: string, file: File, type: RecordType) {
        const fileUID = getExportRecordFileUID(file);
        const exportRecord = await this.getExportRecord(folder);
        exportRecord.queuedFiles = exportRecord.queuedFiles.filter(
            (queuedFilesUID) => queuedFilesUID !== fileUID
        );
        if (type === RecordType.SUCCESS) {
            if (!exportRecord.exportedFiles) {
                exportRecord.exportedFiles = [];
            }
            exportRecord.exportedFiles.push(fileUID);
            exportRecord.failedFiles &&
                (exportRecord.failedFiles = exportRecord.failedFiles.filter(
                    (FailedFileUID) => FailedFileUID !== fileUID
                ));
        } else {
            if (!exportRecord.failedFiles) {
                exportRecord.failedFiles = [];
            }
            if (!exportRecord.failedFiles.find((x) => x === fileUID)) {
                exportRecord.failedFiles.push(fileUID);
            }
        }
        exportRecord.exportedFiles = dedupe(exportRecord.exportedFiles);
        exportRecord.queuedFiles = dedupe(exportRecord.queuedFiles);
        exportRecord.failedFiles = dedupe(exportRecord.failedFiles);
        await this.updateExportRecord(exportRecord, folder);
    }

    async updateExportRecord(newData: Record<string, any>, folder?: string) {
        await this.recordUpdateInProgress;
        this.recordUpdateInProgress = (async () => {
            try {
                if (!folder) {
                    folder = getData(LS_KEYS.EXPORT)?.folder;
                }
                const exportRecord = await this.getExportRecord(folder);
                const newRecord = { ...exportRecord, ...newData };
                await this.ElectronAPIs.setExportRecord(
                    `${folder}/${EXPORT_RECORD_FILE_NAME}`,
                    JSON.stringify(newRecord, null, 2)
                );
            } catch (e) {
                logError(e, 'error updating Export Record');
            }
        })();
    }

    async getExportRecord(folder?: string): Promise<ExportRecord> {
        try {
            await this.recordUpdateInProgress;
            if (!folder) {
                folder = getData(LS_KEYS.EXPORT)?.folder;
            }
            const recordFile = await this.ElectronAPIs.getExportRecord(
                `${folder}/${EXPORT_RECORD_FILE_NAME}`
            );
            if (recordFile) {
                return JSON.parse(recordFile);
            } else {
                return {} as ExportRecord;
            }
        } catch (e) {
            logError(e, 'export Record JSON parsing failed ');
        }
    }

    async downloadAndSave(file: File, collectionPath: string) {
        const usedFileNamesInCollection = this.usedFilenames.get(
            file.collectionID
        );
        file.metadata = mergeMetadata([file])[0].metadata;
        const fileSaveName = getUniqueFileSaveName(
            file.metadata.title,
            usedFileNamesInCollection
        );
        let fileStream = await retryAsyncFunction(() =>
            downloadManager.downloadFile(file)
        );
        const fileType = getFileExtension(file.metadata.title);
        if (
            file.pubMagicMetadata?.data.editedTime &&
            (fileType === TYPE_JPEG || fileType === TYPE_JPG)
        ) {
            const fileBlob = await new Response(fileStream).blob();
            const updatedFileBlob = await updateFileModifyDateInEXIF(
                fileBlob,
                new Date(file.pubMagicMetadata.data.editedTime / 1000)
            );
            fileStream = updatedFileBlob.stream();
        }
        if (file.metadata.fileType === FILE_TYPE.LIVE_PHOTO) {
            this.exportMotionPhoto(fileStream, file, collectionPath);
        } else {
            this.saveMediaFile(collectionPath, fileSaveName, fileStream);
            this.saveMetadataFile(collectionPath, fileSaveName, file.metadata);
        }
    }

    private async exportMotionPhoto(
        fileStream: ReadableStream<any>,
        file: File,
        collectionPath: string
    ) {
        const fileBlob = await new Response(fileStream).blob();
        const originalName = fileNameWithoutExtension(file.metadata.title);
        const motionPhoto = await decodeMotionPhoto(fileBlob, originalName);
        const usedFileNamesInCollection = this.usedFilenames.get(
            file.collectionID
        );
        const imageStream = generateStreamFromArrayBuffer(motionPhoto.image);
        const imageSaveName = getUniqueFileSaveName(
            motionPhoto.imageNameTitle,
            usedFileNamesInCollection
        );
        this.saveMediaFile(collectionPath, imageSaveName, imageStream);
        this.saveMetadataFile(collectionPath, imageSaveName, file.metadata);

        const videoStream = generateStreamFromArrayBuffer(motionPhoto.video);
        const videoSaveName = getUniqueFileSaveName(
            motionPhoto.videoNameTitle,
            usedFileNamesInCollection
        );
        this.saveMediaFile(collectionPath, videoSaveName, videoStream);
        this.saveMetadataFile(collectionPath, videoSaveName, file.metadata);
    }

    private saveMediaFile(collectionPath, uid, fileStream) {
        this.ElectronAPIs.saveStreamToDisk(
            `${collectionPath}/${uid}`,
            fileStream
        );
    }
    private saveMetadataFile(collectionPath, uid, metadata) {
        this.ElectronAPIs.saveFileToDisk(
            `${collectionPath}/${METADATA_FOLDER_NAME}/${uid}.json`,
            getGoogleLikeMetadataFile(uid, metadata)
        );
    }

    isExportInProgress = () => {
        return this.exportInProgress !== null;
    };
}
export default new ExportService();
