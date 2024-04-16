import { convertBytesToHumanReadable } from "@/next/file";
import log from "@/next/log";
import { ComlinkWorker } from "@/next/worker/comlink-worker";
import { CustomError } from "@ente/shared/error";
import { retryAsyncFunction } from "@ente/shared/utils";
import QueueProcessor from "@ente/shared/utils/queueProcessor";
import { getDedicatedConvertWorker } from "utils/comlink/ComlinkConvertWorker";
import { DedicatedConvertWorker } from "worker/convert.worker";

const WORKER_POOL_SIZE = 2;
const WAIT_TIME_BEFORE_NEXT_ATTEMPT_IN_MICROSECONDS = [100, 100];
const WAIT_TIME_IN_MICROSECONDS = 30 * 1000;
const BREATH_TIME_IN_MICROSECONDS = 1000;

class HEICConverter {
    private convertProcessor = new QueueProcessor<Blob>();
    private workerPool: ComlinkWorker<typeof DedicatedConvertWorker>[] = [];
    private ready: Promise<void>;

    constructor() {
        this.ready = this.init();
    }
    private async init() {
        this.workerPool = [];
        for (let i = 0; i < WORKER_POOL_SIZE; i++) {
            this.workerPool.push(getDedicatedConvertWorker());
        }
    }
    async convert(fileBlob: Blob): Promise<Blob> {
        await this.ready;
        const response = this.convertProcessor.queueUpRequest(() =>
            retryAsyncFunction<Blob>(async () => {
                const convertWorker = this.workerPool.shift();
                const worker = await convertWorker.remote;
                try {
                    const convertedHEIC = await new Promise<Blob>(
                        (resolve, reject) => {
                            const main = async () => {
                                try {
                                    const timeout = setTimeout(() => {
                                        reject(Error("wait time exceeded"));
                                    }, WAIT_TIME_IN_MICROSECONDS);
                                    const startTime = Date.now();
                                    const convertedHEIC =
                                        await worker.convertHEICToJPEG(
                                            fileBlob,
                                        );
                                    log.info(
                                        `originalFileSize:${convertBytesToHumanReadable(
                                            fileBlob?.size,
                                        )},convertedFileSize:${convertBytesToHumanReadable(
                                            convertedHEIC?.size,
                                        )},  heic conversion time: ${
                                            Date.now() - startTime
                                        }ms `,
                                    );
                                    clearTimeout(timeout);
                                    resolve(convertedHEIC);
                                } catch (e) {
                                    reject(e);
                                }
                            };
                            main();
                        },
                    );
                    if (!convertedHEIC || convertedHEIC?.size === 0) {
                        log.error(
                            `converted heic fileSize is Zero - ${JSON.stringify(
                                {
                                    originalFileSize:
                                        convertBytesToHumanReadable(
                                            fileBlob?.size ?? 0,
                                        ),
                                    convertedFileSize:
                                        convertBytesToHumanReadable(
                                            convertedHEIC?.size ?? 0,
                                        ),
                                },
                            )}`,
                        );
                    }
                    await new Promise((resolve) => {
                        setTimeout(
                            () => resolve(null),
                            BREATH_TIME_IN_MICROSECONDS,
                        );
                    });
                    this.workerPool.push(convertWorker);
                    return convertedHEIC;
                } catch (e) {
                    log.error("heic conversion failed", e);
                    convertWorker.terminate();
                    this.workerPool.push(getDedicatedConvertWorker());
                    throw e;
                }
            }, WAIT_TIME_BEFORE_NEXT_ATTEMPT_IN_MICROSECONDS),
        );
        try {
            return await response.promise;
        } catch (e) {
            if (e.message === CustomError.REQUEST_CANCELLED) {
                // ignore
                return null;
            }
            throw e;
        }
    }
}

export default new HEICConverter();
