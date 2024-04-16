import { haveWindow } from "@/next/env";
import log from "@/next/log";
import { ComlinkWorker } from "@/next/worker/comlink-worker";
import { getDedicatedCryptoWorker } from "@ente/shared/crypto";
import { DedicatedCryptoWorker } from "@ente/shared/crypto/internal/crypto.worker";
import PQueue from "p-queue";
import { EnteFile } from "types/file";
import {
    BlurDetectionMethod,
    BlurDetectionService,
    ClusteringMethod,
    ClusteringService,
    Face,
    FaceAlignmentMethod,
    FaceAlignmentService,
    FaceCropMethod,
    FaceCropService,
    FaceDetectionMethod,
    FaceDetectionService,
    FaceEmbeddingMethod,
    FaceEmbeddingService,
    MLLibraryData,
    MLSyncConfig,
    MLSyncContext,
} from "types/machineLearning";
import { logQueueStats } from "utils/machineLearning";
import arcfaceAlignmentService from "./arcfaceAlignmentService";
import arcfaceCropService from "./arcfaceCropService";
import dbscanClusteringService from "./dbscanClusteringService";
import hdbscanClusteringService from "./hdbscanClusteringService";
import laplacianBlurDetectionService from "./laplacianBlurDetectionService";
import mobileFaceNetEmbeddingService from "./mobileFaceNetEmbeddingService";
import yoloFaceDetectionService from "./yoloFaceDetectionService";

export class MLFactory {
    public static getFaceDetectionService(
        method: FaceDetectionMethod,
    ): FaceDetectionService {
        if (method === "YoloFace") {
            return yoloFaceDetectionService;
        }

        throw Error("Unknon face detection method: " + method);
    }

    public static getFaceCropService(method: FaceCropMethod) {
        if (method === "ArcFace") {
            return arcfaceCropService;
        }

        throw Error("Unknon face crop method: " + method);
    }

    public static getFaceAlignmentService(
        method: FaceAlignmentMethod,
    ): FaceAlignmentService {
        if (method === "ArcFace") {
            return arcfaceAlignmentService;
        }

        throw Error("Unknon face alignment method: " + method);
    }

    public static getBlurDetectionService(
        method: BlurDetectionMethod,
    ): BlurDetectionService {
        if (method === "Laplacian") {
            return laplacianBlurDetectionService;
        }

        throw Error("Unknon blur detection method: " + method);
    }

    public static getFaceEmbeddingService(
        method: FaceEmbeddingMethod,
    ): FaceEmbeddingService {
        if (method === "MobileFaceNet") {
            return mobileFaceNetEmbeddingService;
        }

        throw Error("Unknon face embedding method: " + method);
    }

    public static getClusteringService(
        method: ClusteringMethod,
    ): ClusteringService {
        if (method === "Hdbscan") {
            return hdbscanClusteringService;
        }
        if (method === "Dbscan") {
            return dbscanClusteringService;
        }

        throw Error("Unknon clustering method: " + method);
    }

    public static getMLSyncContext(
        token: string,
        userID: number,
        config: MLSyncConfig,
        shouldUpdateMLVersion: boolean = true,
    ) {
        return new LocalMLSyncContext(
            token,
            userID,
            config,
            shouldUpdateMLVersion,
        );
    }
}

export class LocalMLSyncContext implements MLSyncContext {
    public token: string;
    public userID: number;
    public config: MLSyncConfig;
    public shouldUpdateMLVersion: boolean;

    public faceDetectionService: FaceDetectionService;
    public faceCropService: FaceCropService;
    public faceAlignmentService: FaceAlignmentService;
    public blurDetectionService: BlurDetectionService;
    public faceEmbeddingService: FaceEmbeddingService;
    public faceClusteringService: ClusteringService;

    public localFilesMap: Map<number, EnteFile>;
    public outOfSyncFiles: EnteFile[];
    public nSyncedFiles: number;
    public nSyncedFaces: number;
    public allSyncedFacesMap?: Map<number, Array<Face>>;

    public error?: Error;

    public mlLibraryData: MLLibraryData;

    public syncQueue: PQueue;
    // TODO: wheather to limit concurrent downloads
    // private downloadQueue: PQueue;

    private concurrency: number;
    private comlinkCryptoWorker: Array<
        ComlinkWorker<typeof DedicatedCryptoWorker>
    >;
    private enteWorkers: Array<any>;

    constructor(
        token: string,
        userID: number,
        config: MLSyncConfig,
        shouldUpdateMLVersion: boolean = true,
        concurrency?: number,
    ) {
        this.token = token;
        this.userID = userID;
        this.config = config;
        this.shouldUpdateMLVersion = shouldUpdateMLVersion;

        this.faceDetectionService = MLFactory.getFaceDetectionService(
            this.config.faceDetection.method,
        );
        this.faceCropService = MLFactory.getFaceCropService(
            this.config.faceCrop.method,
        );
        this.faceAlignmentService = MLFactory.getFaceAlignmentService(
            this.config.faceAlignment.method,
        );
        this.blurDetectionService = MLFactory.getBlurDetectionService(
            this.config.blurDetection.method,
        );
        this.faceEmbeddingService = MLFactory.getFaceEmbeddingService(
            this.config.faceEmbedding.method,
        );
        this.faceClusteringService = MLFactory.getClusteringService(
            this.config.faceClustering.method,
        );

        this.outOfSyncFiles = [];
        this.nSyncedFiles = 0;
        this.nSyncedFaces = 0;

        this.concurrency = concurrency ?? getConcurrency();

        log.info("Using concurrency: ", this.concurrency);
        // timeout is added on downloads
        // timeout on queue will keep the operation open till worker is terminated
        this.syncQueue = new PQueue({ concurrency: this.concurrency });
        logQueueStats(this.syncQueue, "sync");
        // this.downloadQueue = new PQueue({ concurrency: 1 });
        // logQueueStats(this.downloadQueue, 'download');

        this.comlinkCryptoWorker = new Array(this.concurrency);
        this.enteWorkers = new Array(this.concurrency);
    }

    public async getEnteWorker(id: number): Promise<any> {
        const wid = id % this.enteWorkers.length;
        console.log("getEnteWorker: ", id, wid);
        if (!this.enteWorkers[wid]) {
            this.comlinkCryptoWorker[wid] = getDedicatedCryptoWorker();
            this.enteWorkers[wid] = await this.comlinkCryptoWorker[wid].remote;
        }

        return this.enteWorkers[wid];
    }

    public async dispose() {
        this.localFilesMap = undefined;
        await this.syncQueue.onIdle();
        this.syncQueue.removeAllListeners();
        for (const enteComlinkWorker of this.comlinkCryptoWorker) {
            enteComlinkWorker?.terminate();
        }
    }
}

export const getConcurrency = () =>
    haveWindow() && Math.max(2, Math.ceil(navigator.hardwareConcurrency / 2));
