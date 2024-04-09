import { FaceDetection, MlFileData } from "types/machineLearning";
import { ClipEmbedding } from "types/machineLearning/data/clip";

class ServerFileMl {
    public fileID: number;
    public height?: number;
    public width?: number;
    public faceEmbeddings: FaceEmbeddings;
    public clipEmbedding?: ClipEmbedding;
    public updationTime?: number;

    public constructor(
        fileID: number,
        faceEmbedding: FaceEmbeddings,
        clipEmbedding?: ClipEmbedding,
        height?: number,
        width?: number,
        updationTime?: number,
    ) {
        this.fileID = fileID;
        this.height = height;
        this.width = width;
        this.faceEmbeddings = faceEmbedding;
        this.clipEmbedding = clipEmbedding;
        this.updationTime = updationTime;
    }

    toJson(): string {
        return JSON.stringify(this);
    }

    static fromJson(json: string): ServerFileMl {
        return JSON.parse(json);
    }
}

class FaceEmbeddings {
    public faces: Face[];
    public version: number;
    public client?: string;
    public error?: boolean;

    public constructor(
        faces: Face[],
        version: number,
        client?: string,
        error?: boolean,
    ) {
        this.faces = faces;
        this.version = version;
        this.client = client;
        this.error = error;
    }

    toJson(): string {
        return JSON.stringify(this);
    }

    static fromJson(json: string): FaceEmbeddings {
        return JSON.parse(json);
    }
}

class Face {
    public fileID: number;
    public faceID: string;
    public embedding: number[];
    public detection: Detection;
    public score: number;
    public blur: number;
    public fileInfo?: FileInfo;

    public constructor(
        fileID: number,
        faceID: string,
        embedding: number[],
        detection: Detection,
        score: number,
        blur: number,
        fileInfo?: FileInfo,
    ) {
        this.fileID = fileID;
        this.faceID = faceID;
        this.embedding = embedding;
        this.detection = detection;
        this.score = score;
        this.blur = blur;
        this.fileInfo = fileInfo;
    }

    toJson(): string {
        return JSON.stringify(this);
    }

    static fromJson(json: string): Face {
        return JSON.parse(json);
    }
}

class FileInfo {
    public imageWidth?: number;
    public imageHeight?: number;

    public constructor(imageWidth?: number, imageHeight?: number) {
        this.imageWidth = imageWidth;
        this.imageHeight = imageHeight;
    }
}

class Detection {
    public box: FaceBox;
    public landmarks: Landmark[];

    public constructor(box: FaceBox, landmarks: Landmark[]) {
        this.box = box;
        this.landmarks = landmarks;
    }

    toJson(): string {
        return JSON.stringify(this);
    }

    static fromJson(json: string): Detection {
        return JSON.parse(json);
    }
}

class FaceBox {
    public xMin: number;
    public yMin: number;
    public width: number;
    public height: number;

    public constructor(
        xMin: number,
        yMin: number,
        width: number,
        height: number,
    ) {
        this.xMin = xMin;
        this.yMin = yMin;
        this.width = width;
        this.height = height;
    }

    toJson(): string {
        return JSON.stringify(this);
    }

    static fromJson(json: string): FaceBox {
        return JSON.parse(json);
    }
}

class Landmark {
    public x: number;
    public y: number;

    public constructor(x: number, y: number) {
        this.x = x;
        this.y = y;
    }

    toJson(): string {
        return JSON.stringify(this);
    }

    static fromJson(json: string): Landmark {
        return JSON.parse(json);
    }
}

export function localFileMlDataToServerFileMl(
    localFileMlData: MlFileData,
): ServerFileMl {
    const imageDimensions = localFileMlData.imageDimensions;
    const fileInfo = new FileInfo(
        imageDimensions.width,
        imageDimensions.height,
    );
    const faces: Face[] = [];
    for (let i = 0; i < localFileMlData.faces.length; i++) {
        const face = localFileMlData.faces[i];
        const faceID = face.id;
        const embedding = face.embedding;
        const score = face.detection.probability;
        const blur = face.blurValue;
        const detection: FaceDetection = face.detection;
        const box = detection.box;
        const landmarks = detection.landmarks;
        const newBox = new FaceBox(
            Math.round(box.x / imageDimensions.width),
            Math.round(box.y / imageDimensions.height),
            Math.round(box.width / imageDimensions.width),
            Math.round(box.height / imageDimensions.height),
        );
        const newLandmarks: Landmark[] = [];
        for (let j = 0; j < landmarks.length; j++) {
            newLandmarks.push(
                new Landmark(
                    Math.round(landmarks[j].x / imageDimensions.width),
                    Math.round(landmarks[j].y / imageDimensions.height),
                ),
            );
        }
        const newFaceObject = new Face(
            localFileMlData.fileId,
            faceID,
            Array.from(embedding),
            new Detection(newBox, newLandmarks),
            score,
            blur,
            fileInfo,
        );
        faces.push(newFaceObject);
    }
    const faceEmbeddings = new FaceEmbeddings(faces, 1, "web");
    return new ServerFileMl(
        localFileMlData.fileId,
        faceEmbeddings,
        null,
        imageDimensions.height,
        imageDimensions.width,
    );
}

// Not sure if this actually works
export function ServerFileMlToLocalFileMlData(
    serverFileMl: ServerFileMl,
): MlFileData {
    const faces = [];
    const mlVersion: number = serverFileMl.faceEmbeddings.version;
    const errorCount = serverFileMl.faceEmbeddings.error ? 1 : 0;
    for (let i = 0; i < serverFileMl.faceEmbeddings.faces.length; i++) {
        const face = serverFileMl.faceEmbeddings.faces[i];
        const detection = face.detection;
        const box = detection.box;
        const landmarks = detection.landmarks;
        const newBox = new FaceBox(
            box.xMin * serverFileMl.width,
            box.yMin * serverFileMl.height,
            box.width * serverFileMl.width,
            box.height * serverFileMl.height,
        );
        const newLandmarks: Landmark[] = [];
        for (let j = 0; j < landmarks.length; j++) {
            newLandmarks.push(
                new Landmark(
                    landmarks[j].x * serverFileMl.width,
                    landmarks[j].y * serverFileMl.height,
                ),
            );
        }
        const newDetection = new Detection(newBox, newLandmarks);
        const newFace = new Face(
            serverFileMl.fileID,
            face.faceID,
            face.embedding,
            newDetection,
            face.score,
            face.blur,
            new FileInfo(serverFileMl.width, serverFileMl.height),
        );
        faces.push(newFace);
    }
    return {
        fileId: serverFileMl.fileID,
        imageDimensions: {
            width: serverFileMl.width,
            height: serverFileMl.height,
        },
        faces,
        mlVersion,
        errorCount,
    };
}
