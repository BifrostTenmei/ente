import { FILE_TYPE } from "@/media/file-type";
import { potentialFileTypeFromExtension } from "@/media/live-photo";
import { ensureElectron } from "@/next/electron";
import { lowercaseExtension, nameAndExtension } from "@/next/file";
import log from "@/next/log";
import { ElectronFile } from "@/next/types/file";
import type { Electron } from "@/next/types/ipc";
import { ComlinkWorker } from "@/next/worker/comlink-worker";
import { ensure } from "@/utils/ensure";
import { getDedicatedCryptoWorker } from "@ente/shared/crypto";
import { DedicatedCryptoWorker } from "@ente/shared/crypto/internal/crypto.worker";
import { CustomError } from "@ente/shared/error";
import { Events, eventBus } from "@ente/shared/events";
import { wait } from "@ente/shared/utils";
import { Canceler } from "axios";
import { Remote } from "comlink";
import {
    RANDOM_PERCENTAGE_PROGRESS_FOR_PUT,
    UPLOAD_RESULT,
    UPLOAD_STAGES,
} from "constants/upload";
import isElectron from "is-electron";
import {
    getLocalPublicFiles,
    getPublicCollectionUID,
} from "services/publicCollectionService";
import { getDisableCFUploadProxyFlag } from "services/userService";
import watcher from "services/watch";
import { Collection } from "types/collection";
import { EncryptedEnteFile, EnteFile } from "types/file";
import { SetFiles } from "types/gallery";
import { decryptFile, getUserOwnedFiles, sortFiles } from "utils/file";
import { getLocalFiles } from "../fileService";
import {
    getMetadataJSONMapKeyForJSON,
    tryParseTakeoutMetadataJSON,
    type ParsedMetadataJSON,
} from "./takeout";
import UploadService, { fopFileName, fopSize, uploader } from "./uploadService";

export type FileID = number;

export type PercentageUploaded = number;
/* localID => fileName */
export type UploadFileNames = Map<FileID, string>;

export interface UploadCounter {
    finished: number;
    total: number;
}

export interface InProgressUpload {
    localFileID: FileID;
    progress: PercentageUploaded;
}

export interface FinishedUpload {
    localFileID: FileID;
    result: UPLOAD_RESULT;
}

export type InProgressUploads = Map<FileID, PercentageUploaded>;

export type FinishedUploads = Map<FileID, UPLOAD_RESULT>;

export type SegregatedFinishedUploads = Map<UPLOAD_RESULT, FileID[]>;

export interface ProgressUpdater {
    setPercentComplete: React.Dispatch<React.SetStateAction<number>>;
    setUploadCounter: React.Dispatch<React.SetStateAction<UploadCounter>>;
    setUploadStage: React.Dispatch<React.SetStateAction<UPLOAD_STAGES>>;
    setInProgressUploads: React.Dispatch<
        React.SetStateAction<InProgressUpload[]>
    >;
    setFinishedUploads: React.Dispatch<
        React.SetStateAction<SegregatedFinishedUploads>
    >;
    setUploadFilenames: React.Dispatch<React.SetStateAction<UploadFileNames>>;
    setHasLivePhotos: React.Dispatch<React.SetStateAction<boolean>>;
    setUploadProgressView: React.Dispatch<React.SetStateAction<boolean>>;
}

/** The number of uploads to process in parallel. */
const maxConcurrentUploads = 4;

export interface FileWithCollection {
    localID: number;
    collectionID: number;
    isLivePhoto?: boolean;
    fileOrPath?: File | string;
    livePhotoAssets?: LivePhotoAssets;
}

export interface LivePhotoAssets {
    image: File | string;
    video: File | string;
}

export interface PublicUploadProps {
    token: string;
    passwordToken: string;
    accessedThroughSharedURL: boolean;
}

interface UploadCancelStatus {
    value: boolean;
}

class UploadCancelService {
    private shouldUploadBeCancelled: UploadCancelStatus = {
        value: false,
    };

    reset() {
        this.shouldUploadBeCancelled.value = false;
    }

    requestUploadCancelation() {
        this.shouldUploadBeCancelled.value = true;
    }

    isUploadCancelationRequested(): boolean {
        return this.shouldUploadBeCancelled.value;
    }
}

const uploadCancelService = new UploadCancelService();

class UIService {
    private progressUpdater: ProgressUpdater;

    // UPLOAD LEVEL STATES
    private uploadStage: UPLOAD_STAGES = UPLOAD_STAGES.START;
    private filenames: Map<number, string> = new Map();
    private hasLivePhoto: boolean = false;
    private uploadProgressView: boolean = false;

    // STAGE LEVEL STATES
    private perFileProgress: number;
    private filesUploadedCount: number;
    private totalFilesCount: number;
    private inProgressUploads: InProgressUploads = new Map();
    private finishedUploads: FinishedUploads = new Map();

    init(progressUpdater: ProgressUpdater) {
        this.progressUpdater = progressUpdater;
        this.progressUpdater.setUploadStage(this.uploadStage);
        this.progressUpdater.setUploadFilenames(this.filenames);
        this.progressUpdater.setHasLivePhotos(this.hasLivePhoto);
        this.progressUpdater.setUploadProgressView(this.uploadProgressView);
        this.progressUpdater.setUploadCounter({
            finished: this.filesUploadedCount,
            total: this.totalFilesCount,
        });
        this.progressUpdater.setInProgressUploads(
            convertInProgressUploadsToList(this.inProgressUploads),
        );
        this.progressUpdater.setFinishedUploads(
            groupByResult(this.finishedUploads),
        );
    }

    reset(count = 0) {
        this.setTotalFileCount(count);
        this.filesUploadedCount = 0;
        this.inProgressUploads = new Map<number, number>();
        this.finishedUploads = new Map<number, UPLOAD_RESULT>();
        this.updateProgressBarUI();
    }

    setTotalFileCount(count: number) {
        this.totalFilesCount = count;
        if (count > 0) {
            this.perFileProgress = 100 / this.totalFilesCount;
        } else {
            this.perFileProgress = 0;
        }
    }

    setFileProgress(key: number, progress: number) {
        this.inProgressUploads.set(key, progress);
        this.updateProgressBarUI();
    }

    setUploadStage(stage: UPLOAD_STAGES) {
        this.uploadStage = stage;
        this.progressUpdater.setUploadStage(stage);
    }

    setFiles(files: { localID: number; fileName: string }[]) {
        const filenames = new Map(files.map((f) => [f.localID, f.fileName]));
        this.filenames = filenames;
        this.progressUpdater.setUploadFilenames(filenames);
    }

    setHasLivePhoto(hasLivePhoto: boolean) {
        this.hasLivePhoto = hasLivePhoto;
        this.progressUpdater.setHasLivePhotos(hasLivePhoto);
    }

    setUploadProgressView(uploadProgressView: boolean) {
        this.uploadProgressView = uploadProgressView;
        this.progressUpdater.setUploadProgressView(uploadProgressView);
    }

    increaseFileUploaded() {
        this.filesUploadedCount++;
        this.updateProgressBarUI();
    }

    moveFileToResultList(key: number, uploadResult: UPLOAD_RESULT) {
        this.finishedUploads.set(key, uploadResult);
        this.inProgressUploads.delete(key);
        this.updateProgressBarUI();
    }

    hasFilesInResultList() {
        return this.finishedUploads.size > 0;
    }

    private updateProgressBarUI() {
        const {
            setPercentComplete,
            setUploadCounter,
            setInProgressUploads,
            setFinishedUploads,
        } = this.progressUpdater;
        setUploadCounter({
            finished: this.filesUploadedCount,
            total: this.totalFilesCount,
        });
        let percentComplete =
            this.perFileProgress *
            (this.finishedUploads.size || this.filesUploadedCount);
        if (this.inProgressUploads) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            for (const [_, progress] of this.inProgressUploads) {
                // filter  negative indicator values during percentComplete calculation
                if (progress < 0) {
                    continue;
                }
                percentComplete += (this.perFileProgress * progress) / 100;
            }
        }

        setPercentComplete(percentComplete);
        setInProgressUploads(
            convertInProgressUploadsToList(this.inProgressUploads),
        );
        setFinishedUploads(groupByResult(this.finishedUploads));
    }

    trackUploadProgress(
        fileLocalID: number,
        percentPerPart = RANDOM_PERCENTAGE_PROGRESS_FOR_PUT(),
        index = 0,
    ) {
        const cancel: { exec: Canceler } = { exec: () => {} };
        const cancelTimedOutRequest = () =>
            cancel.exec(CustomError.REQUEST_TIMEOUT);

        const cancelCancelledUploadRequest = () =>
            cancel.exec(CustomError.UPLOAD_CANCELLED);

        let timeout = null;
        const resetTimeout = () => {
            if (timeout) {
                clearTimeout(timeout);
            }
            timeout = setTimeout(cancelTimedOutRequest, 30 * 1000 /* 30 sec */);
        };
        return {
            cancel,
            onUploadProgress: (event) => {
                this.inProgressUploads.set(
                    fileLocalID,
                    Math.min(
                        Math.round(
                            percentPerPart * index +
                                (percentPerPart * event.loaded) / event.total,
                        ),
                        98,
                    ),
                );
                this.updateProgressBarUI();
                if (event.loaded === event.total) {
                    clearTimeout(timeout);
                } else {
                    resetTimeout();
                }
                if (uploadCancelService.isUploadCancelationRequested()) {
                    cancelCancelledUploadRequest();
                }
            },
        };
    }
}

function convertInProgressUploadsToList(inProgressUploads) {
    return [...inProgressUploads.entries()].map(
        ([localFileID, progress]) =>
            ({
                localFileID,
                progress,
            }) as InProgressUpload,
    );
}

const groupByResult = (finishedUploads: FinishedUploads) => {
    const groups: SegregatedFinishedUploads = new Map();
    for (const [localID, result] of finishedUploads) {
        if (!groups.has(result)) groups.set(result, []);
        groups.get(result).push(localID);
    }
    return groups;
};

class UploadManager {
    private cryptoWorkers = new Array<
        ComlinkWorker<typeof DedicatedCryptoWorker>
    >(maxConcurrentUploads);
    private parsedMetadataJSONMap: Map<string, ParsedMetadataJSON>;
    private filesToBeUploaded: ClusteredFile[];
    private remainingFiles: ClusteredFile[] = [];
    private failedFiles: ClusteredFile[];
    private existingFiles: EnteFile[];
    private setFiles: SetFiles;
    private collections: Map<number, Collection>;
    private uploadInProgress: boolean;
    private publicUploadProps: PublicUploadProps;
    private uploaderName: string;
    private uiService: UIService;
    private isCFUploadProxyDisabled: boolean = false;

    constructor() {
        this.uiService = new UIService();
    }

    public async init(
        progressUpdater: ProgressUpdater,
        setFiles: SetFiles,
        publicCollectProps: PublicUploadProps,
        isCFUploadProxyDisabled: boolean,
    ) {
        this.uiService.init(progressUpdater);
        const remoteIsCFUploadProxyDisabled =
            await getDisableCFUploadProxyFlag();
        if (remoteIsCFUploadProxyDisabled) {
            isCFUploadProxyDisabled = remoteIsCFUploadProxyDisabled;
        }
        this.isCFUploadProxyDisabled = isCFUploadProxyDisabled;
        UploadService.init(publicCollectProps);
        this.setFiles = setFiles;
        this.publicUploadProps = publicCollectProps;
    }

    public isUploadRunning() {
        return this.uploadInProgress;
    }

    private resetState() {
        this.filesToBeUploaded = [];
        this.remainingFiles = [];
        this.failedFiles = [];
        this.parsedMetadataJSONMap = new Map<string, ParsedMetadataJSON>();

        this.uploaderName = null;
    }

    public prepareForNewUpload() {
        this.resetState();
        this.uiService.reset();
        uploadCancelService.reset();
        this.uiService.setUploadStage(UPLOAD_STAGES.START);
    }

    showUploadProgressDialog() {
        this.uiService.setUploadProgressView(true);
    }

    /**
     * Upload files
     *
     * This method waits for all the files to get uploaded (successfully or
     * unsucessfully) before returning.
     *
     * It is an error to call this method when there is already an in-progress
     * upload.
     *
     * @param filesWithCollectionToUploadIn The files to upload, each paired
     * with the id of the collection that they should be uploaded into.
     *
     * @returns `true` if at least one file was processed
     */
    public async uploadFiles(
        filesWithCollectionToUploadIn: FileWithCollection[],
        collections: Collection[],
        uploaderName?: string,
    ) {
        if (this.uploadInProgress)
            throw new Error("Cannot run multiple uploads at once");

        log.info(`Uploading ${filesWithCollectionToUploadIn.length} files`);
        this.uploadInProgress = true;
        this.uploaderName = uploaderName;

        try {
            await this.updateExistingFilesAndCollections(collections);

            const namedFiles = filesWithCollectionToUploadIn.map(
                makeFileWithCollectionIDAndName,
            );

            this.uiService.setFiles(namedFiles);

            const [metadataFiles, mediaFiles] =
                splitMetadataAndMediaFiles(namedFiles);

            if (metadataFiles.length) {
                this.uiService.setUploadStage(
                    UPLOAD_STAGES.READING_GOOGLE_METADATA_FILES,
                );

                await this.parseMetadataJSONFiles(metadataFiles);
            }

            if (mediaFiles.length) {
                const clusteredMediaFiles = await clusterLivePhotos(mediaFiles);

                this.abortIfCancelled();

                // Live photos might've been clustered together, reset the list
                // of files to reflect that.
                this.uiService.setFiles(clusteredMediaFiles);

                this.uiService.setHasLivePhoto(
                    mediaFiles.length != clusteredMediaFiles.length,
                );

                await this.uploadMediaFiles(clusteredMediaFiles);
            }
        } catch (e) {
            if (e.message === CustomError.UPLOAD_CANCELLED) {
                if (isElectron()) {
                    this.remainingFiles = [];
                    await cancelRemainingUploads();
                }
            } else {
                log.error("Uploading failed", e);
                throw e;
            }
        } finally {
            this.uiService.setUploadStage(UPLOAD_STAGES.FINISH);
            for (let i = 0; i < maxConcurrentUploads; i++) {
                this.cryptoWorkers[i]?.terminate();
            }
            this.uploadInProgress = false;
        }

        return this.uiService.hasFilesInResultList();
    }

    private abortIfCancelled = () => {
        if (uploadCancelService.isUploadCancelationRequested()) {
            throw Error(CustomError.UPLOAD_CANCELLED);
        }
    };

    private async updateExistingFilesAndCollections(collections: Collection[]) {
        if (this.publicUploadProps.accessedThroughSharedURL) {
            this.existingFiles = await getLocalPublicFiles(
                getPublicCollectionUID(this.publicUploadProps.token),
            );
        } else {
            this.existingFiles = getUserOwnedFiles(await getLocalFiles());
        }
        this.collections = new Map(
            collections.map((collection) => [collection.id, collection]),
        );
    }

    private async parseMetadataJSONFiles(files: FileWithCollectionIDAndName[]) {
        this.uiService.reset(files.length);

        for (const { fileOrPath, fileName, collectionID } of files) {
            this.abortIfCancelled();

            log.info(`Parsing metadata JSON ${fileName}`);
            const metadataJSON = await tryParseTakeoutMetadataJSON(fileOrPath);
            if (metadataJSON) {
                this.parsedMetadataJSONMap.set(
                    getMetadataJSONMapKeyForJSON(collectionID, fileName),
                    metadataJSON,
                );
                this.uiService.increaseFileUploaded();
            }
        }
    }

    private async uploadMediaFiles(mediaFiles: ClusteredFile[]) {
        this.filesToBeUploaded = [...this.filesToBeUploaded, ...mediaFiles];

        if (isElectron()) {
            this.remainingFiles = [...this.remainingFiles, ...mediaFiles];
        }

        this.uiService.reset(mediaFiles.length);

        await UploadService.setFileCount(mediaFiles.length);

        this.uiService.setUploadStage(UPLOAD_STAGES.UPLOADING);

        const uploadProcesses = [];
        for (
            let i = 0;
            i < maxConcurrentUploads && this.filesToBeUploaded.length > 0;
            i++
        ) {
            this.cryptoWorkers[i] = getDedicatedCryptoWorker();
            const worker = await this.cryptoWorkers[i].remote;
            uploadProcesses.push(this.uploadNextFileInQueue(worker));
        }
        await Promise.all(uploadProcesses);
    }

    private async uploadNextFileInQueue(worker: Remote<DedicatedCryptoWorker>) {
        const uiService = this.uiService;

        while (this.filesToBeUploaded.length > 0) {
            this.abortIfCancelled();

            const clusteredFile = this.filesToBeUploaded.pop();
            const { localID, collectionID } = clusteredFile;
            const collection = this.collections.get(collectionID);
            const uploadableFile = { ...clusteredFile, collection };

            uiService.setFileProgress(localID, 0);
            await wait(0);

            const { uploadResult, uploadedFile } = await uploader(
                uploadableFile,
                this.uploaderName,
                this.existingFiles,
                this.parsedMetadataJSONMap,
                worker,
                this.isCFUploadProxyDisabled,
                () => {
                    this.abortIfCancelled();
                },
                (
                    fileLocalID: number,
                    percentPerPart?: number,
                    index?: number,
                ) =>
                    uiService.trackUploadProgress(
                        fileLocalID,
                        percentPerPart,
                        index,
                    ),
            );

            const finalUploadResult = await this.postUploadTask(
                uploadableFile,
                uploadResult,
                uploadedFile,
            );

            this.uiService.moveFileToResultList(localID, finalUploadResult);
            this.uiService.increaseFileUploaded();
            UploadService.reducePendingUploadCount();
        }
    }

    private async postUploadTask(
        uploadableFile: UploadableFile,
        uploadResult: UPLOAD_RESULT,
        uploadedFile: EncryptedEnteFile | EnteFile | undefined,
    ) {
        log.info(
            `Uploaded ${uploadableFile.fileName} with result ${uploadResult}`,
        );
        try {
            let decryptedFile: EnteFile;
            await this.removeFromPendingUploads(uploadableFile);
            switch (uploadResult) {
                case UPLOAD_RESULT.FAILED:
                case UPLOAD_RESULT.BLOCKED:
                    this.failedFiles.push(uploadableFile);
                    break;
                case UPLOAD_RESULT.ALREADY_UPLOADED:
                    decryptedFile = uploadedFile as EnteFile;
                    break;
                case UPLOAD_RESULT.ADDED_SYMLINK:
                    decryptedFile = uploadedFile as EnteFile;
                    uploadResult = UPLOAD_RESULT.UPLOADED;
                    break;
                case UPLOAD_RESULT.UPLOADED:
                case UPLOAD_RESULT.UPLOADED_WITH_STATIC_THUMBNAIL:
                    decryptedFile = await decryptFile(
                        uploadedFile as EncryptedEnteFile,
                        uploadableFile.collection.key,
                    );
                    break;
                case UPLOAD_RESULT.UNSUPPORTED:
                case UPLOAD_RESULT.TOO_LARGE:
                    // no-op
                    break;
                default:
                    throw new Error(`Invalid Upload Result ${uploadResult}`);
            }
            if (
                [
                    UPLOAD_RESULT.ADDED_SYMLINK,
                    UPLOAD_RESULT.UPLOADED,
                    UPLOAD_RESULT.UPLOADED_WITH_STATIC_THUMBNAIL,
                ].includes(uploadResult)
            ) {
                try {
                    eventBus.emit(Events.FILE_UPLOADED, {
                        enteFile: decryptedFile,
                        localFile:
                            uploadableFile.fileOrPath ??
                            uploadableFile.livePhotoAssets.image,
                    });
                } catch (e) {
                    log.warn("Ignoring error in fileUploaded handlers", e);
                }
                this.updateExistingFiles(decryptedFile);
            }
            await this.watchFolderCallback(
                uploadResult,
                uploadableFile,
                uploadedFile as EncryptedEnteFile,
            );
            return uploadResult;
        } catch (e) {
            log.error("failed to do post file upload action", e);
            return UPLOAD_RESULT.FAILED;
        }
    }

    private async watchFolderCallback(
        fileUploadResult: UPLOAD_RESULT,
        fileWithCollection: ClusteredFile,
        uploadedFile: EncryptedEnteFile,
    ) {
        if (isElectron()) {
            if (watcher.isUploadRunning()) {
                await watcher.onFileUpload(
                    fileUploadResult,
                    fileWithCollection,
                    uploadedFile,
                );
            }
        }
    }

    public cancelRunningUpload() {
        log.info("User cancelled running upload");
        this.uiService.setUploadStage(UPLOAD_STAGES.CANCELLING);
        uploadCancelService.requestUploadCancelation();
    }

    public getFailedFilesWithCollections() {
        return {
            files: this.failedFiles,
            collections: [...this.collections.values()],
        };
    }

    public getUploaderName() {
        return this.uploaderName;
    }

    private updateExistingFiles(decryptedFile: EnteFile) {
        if (!decryptedFile) {
            throw Error("decrypted file can't be undefined");
        }
        this.existingFiles.push(decryptedFile);
        this.updateUIFiles(decryptedFile);
    }

    private updateUIFiles(decryptedFile: EnteFile) {
        this.setFiles((files) => sortFiles([...files, decryptedFile]));
    }

    private async removeFromPendingUploads({ localID }: ClusteredFile) {
        const electron = globalThis.electron;
        if (electron) {
            this.remainingFiles = this.remainingFiles.filter(
                (f) => f.localID != localID,
            );
            await updatePendingUploads(electron, this.remainingFiles);
        }
    }

    public shouldAllowNewUpload = () => {
        return !this.uploadInProgress || watcher.isUploadRunning();
    };
}

export default new UploadManager();

/**
 * The data operated on by the intermediate stages of the upload.
 *
 * [Note: Intermediate file types during upload]
 *
 * As files progress through stages, they get more and more bits tacked on to
 * them. These types document the journey.
 *
 * - The input is {@link FileWithCollection}. This can either be a new
 *   {@link FileWithCollection}, in which case it'll only have a
 *   {@link localID}, {@link collectionID} and a {@link fileOrPath}. Or it could
 *   be a retry, in which case it'll not have a {@link fileOrPath} but instead
 *   will have data from a previous stage (concretely, it'll just be a
 *   relabelled {@link ClusteredFile}), like a snake eating its tail.
 *
 * - Immediately we convert it to {@link FileWithCollectionIDAndName}. This is
 *   to mostly systematize what we have, and also attach a {@link fileName}.
 *
 * - These then get converted to "assets", whereby both parts of a live photo
 *   are combined. This is a {@link ClusteredFile}.
 *
 * - On to the {@link ClusteredFile} we attach the corresponding
 *   {@link collection}, giving us {@link UploadableFile}. This is what gets
 *   queued and then passed to the {@link uploader}.
 */
type FileWithCollectionIDAndName = {
    /** A unique ID for the duration of the upload */
    localID: number;
    /** The ID of the collection to which this file should be uploaded. */
    collectionID: number;
    /**
     * The name of the file.
     *
     * In case of live photos, this'll be the name of the image part.
     */
    fileName: string;
    /** `true` if this is a live photo. */
    isLivePhoto?: boolean;
    /* Valid for non-live photos */
    fileOrPath?: File | string;
    /* Valid for live photos */
    livePhotoAssets?: LivePhotoAssets;
};

const makeFileWithCollectionIDAndName = (
    f: FileWithCollection,
): FileWithCollectionIDAndName => {
    const fileOrPath = f.fileOrPath;
    /* TODO(MR): ElectronFile */
    if (!(fileOrPath instanceof File || typeof fileOrPath == "string"))
        throw new Error(`Unexpected file ${f}`);

    return {
        localID: ensure(f.localID),
        collectionID: ensure(f.collectionID),
        fileName: ensure(
            f.isLivePhoto
                ? fopFileName(f.livePhotoAssets.image)
                : fopFileName(fileOrPath),
        ),
        isLivePhoto: f.isLivePhoto,
        fileOrPath: fileOrPath,
        livePhotoAssets: f.livePhotoAssets,
    };
};

/**
 * A file with both parts of a live photo clubbed together.
 *
 * See: [Note: Intermediate file types during upload].
 */
type ClusteredFile = {
    localID: number;
    collectionID: number;
    fileName: string;
    isLivePhoto: boolean;
    fileOrPath?: File | string;
    livePhotoAssets?: LivePhotoAssets;
};

/**
 * The file that we hand off to the uploader. Essentially {@link ClusteredFile}
 * with the {@link collection} attached to it.
 *
 * See: [Note: Intermediate file types during upload].
 */
export type UploadableFile = ClusteredFile & {
    collection: Collection;
};

const splitMetadataAndMediaFiles = (
    files: FileWithCollectionIDAndName[],
): [
    metadata: FileWithCollectionIDAndName[],
    media: FileWithCollectionIDAndName[],
] =>
    files.reduce(
        ([metadata, media], f) => {
            if (lowercaseExtension(f.fileName) == "json") metadata.push(f);
            else media.push(f);
            return [metadata, media];
        },
        [[], []],
    );

export const setToUploadCollection = async (collections: Collection[]) => {
    let collectionName: string = null;
    /* collection being one suggest one of two things
                1. Either the user has upload to a single existing collection
                2. Created a new single collection to upload to
                    may have had multiple folder, but chose to upload
                    to one album
                hence saving the collection name when upload collection count is 1
                helps the info of user choosing this options
                and on next upload we can directly start uploading to this collection
            */
    if (collections.length === 1) {
        collectionName = collections[0].name;
    }
    await ensureElectron().setPendingUploadCollection(collectionName);
};

const updatePendingUploads = async (
    electron: Electron,
    files: ClusteredFile[],
) => {
    const paths = files
        .map((file) =>
            file.isLivePhoto
                ? [file.livePhotoAssets.image, file.livePhotoAssets.video]
                : [file.fileOrPath],
        )
        .flat()
        .map((f) => getFilePathElectron(f));
    await electron.setPendingUploadFiles("files", paths);
};

/**
 * NOTE: a stop gap measure, only meant to be called by code that is running in
 * the context of a desktop app initiated upload
 */
export const getFilePathElectron = (file: File | ElectronFile | string) =>
    typeof file == "string" ? file : (file as ElectronFile).path;

const cancelRemainingUploads = async () => {
    const electron = ensureElectron();
    await electron.setPendingUploadCollection(undefined);
    await electron.setPendingUploadFiles("zips", []);
    await electron.setPendingUploadFiles("files", []);
};

/**
 * Go through the given files, combining any sibling image + video assets into a
 * single live photo when appropriate.
 */
const clusterLivePhotos = async (files: FileWithCollectionIDAndName[]) => {
    const result: ClusteredFile[] = [];
    files
        .sort((f, g) =>
            nameAndExtension(f.fileName)[0].localeCompare(
                nameAndExtension(g.fileName)[0],
            ),
        )
        .sort((f, g) => f.collectionID - g.collectionID);
    let index = 0;
    while (index < files.length - 1) {
        const f = files[index];
        const g = files[index + 1];
        const fFileType = potentialFileTypeFromExtension(f.fileName);
        const gFileType = potentialFileTypeFromExtension(g.fileName);
        const fa: PotentialLivePhotoAsset = {
            fileName: f.fileName,
            fileType: fFileType,
            collectionID: f.collectionID,
            fileOrPath: f.fileOrPath,
        };
        const ga: PotentialLivePhotoAsset = {
            fileName: g.fileName,
            fileType: gFileType,
            collectionID: g.collectionID,
            fileOrPath: g.fileOrPath,
        };
        if (await areLivePhotoAssets(fa, ga)) {
            const [image, video] =
                fFileType == FILE_TYPE.IMAGE ? [f, g] : [g, f];
            result.push({
                localID: f.localID,
                collectionID: f.collectionID,
                fileName: image.fileName,
                isLivePhoto: true,
                livePhotoAssets: {
                    image: image.fileOrPath,
                    video: video.fileOrPath,
                },
            });
            index += 2;
        } else {
            result.push({
                ...f,
                isLivePhoto: false,
            });
            index += 1;
        }
    }
    if (index === files.length - 1) {
        result.push({
            ...files[index],
            isLivePhoto: false,
        });
    }
    return result;
};

interface PotentialLivePhotoAsset {
    fileName: string;
    fileType: FILE_TYPE;
    collectionID: number;
    fileOrPath: File | string;
}

const areLivePhotoAssets = async (
    f: PotentialLivePhotoAsset,
    g: PotentialLivePhotoAsset,
) => {
    if (f.collectionID != g.collectionID) return false;

    const [fName, fExt] = nameAndExtension(f.fileName);
    const [gName, gExt] = nameAndExtension(g.fileName);

    let fPrunedName: string;
    let gPrunedName: string;
    if (f.fileType == FILE_TYPE.IMAGE && g.fileType == FILE_TYPE.VIDEO) {
        fPrunedName = removePotentialLivePhotoSuffix(
            fName,
            // A Google Live Photo image file can have video extension appended
            // as suffix, so we pass that to removePotentialLivePhotoSuffix to
            // remove it.
            //
            // Example: IMG_20210630_0001.mp4.jpg (Google Live Photo image file)
            gExt ? `.${gExt}` : undefined,
        );
        gPrunedName = removePotentialLivePhotoSuffix(gName);
    } else if (f.fileType == FILE_TYPE.VIDEO && g.fileType == FILE_TYPE.IMAGE) {
        fPrunedName = removePotentialLivePhotoSuffix(fName);
        gPrunedName = removePotentialLivePhotoSuffix(
            gName,
            fExt ? `.${fExt}` : undefined,
        );
    } else {
        return false;
    }

    if (fPrunedName != gPrunedName) return false;

    // Also check that the size of an individual Live Photo asset is less than
    // an (arbitrary) limit. This should be true in practice as the videos for a
    // live photo are a few seconds long. Further on, the zipping library that
    // we use doesn't support stream as a input.

    const maxAssetSize = 20 * 1024 * 1024; /* 20MB */
    const fSize = await fopSize(f.fileOrPath);
    const gSize = await fopSize(g.fileOrPath);
    if (fSize > maxAssetSize || gSize > maxAssetSize) {
        log.info(
            `Not classifying assets with too large sizes ${[fSize, gSize]} as a live photo`,
        );
        return false;
    }

    return true;
};

const removePotentialLivePhotoSuffix = (name: string, suffix?: string) => {
    const suffix_3 = "_3";

    // The icloud-photos-downloader library appends _HVEC to the end of the
    // filename in case of live photos.
    //
    // https://github.com/icloud-photos-downloader/icloud_photos_downloader
    const suffix_hvec = "_HVEC";

    let foundSuffix: string | undefined;
    if (name.endsWith(suffix_3)) {
        foundSuffix = suffix_3;
    } else if (
        name.endsWith(suffix_hvec) ||
        name.endsWith(suffix_hvec.toLowerCase())
    ) {
        foundSuffix = suffix_hvec;
    } else if (suffix) {
        if (name.endsWith(suffix) || name.endsWith(suffix.toLowerCase())) {
            foundSuffix = suffix;
        }
    }

    return foundSuffix ? name.slice(0, foundSuffix.length * -1) : name;
};
