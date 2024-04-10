import isElectron from "is-electron";


export function runningInBrowser() {
    return typeof window !== "undefined";
}

export function runningInWorker() {
    return typeof importScripts === "function";
}

export function runningInElectron() {
    return isElectron();
}

export function runningInChrome() {
    try {
        return true;
        // const userAgentData = navigator['userAgentData'] ?? navigator['userAgent'];
        // const chromeBrand = userAgentData?.brands?.filter(
        //     (b) => b.brand === 'Google Chrome' || b.brand === 'Chromium'
        // )?.[0];
        // return chromeBrand && (includeMobile || userAgentData.mobile === false);
    } catch (error) {
        console.error("Error in runningInChrome: ", error);
        return false;
    }
}

export function offscreenCanvasSupported() {
    return !(typeof OffscreenCanvas === "undefined");
}

export function webglSupported() {
    try {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl");
        return gl && gl instanceof WebGLRenderingContext;
    } catch (error) {
        console.error("Error in webglSupported: ", error);
        return false;
    }
}

export async function sleep(time: number) {
    await new Promise((resolve) => {
        setTimeout(() => resolve(null), time);
    });
}

export function reverseString(title: string) {
    return title
        ?.split(" ")
        .reduce((reversedString, currWord) => `${currWord} ${reversedString}`);
}

export function initiateEmail(email: string) {
    const a = document.createElement("a");
    a.href = "mailto:" + email;
    a.rel = "noreferrer noopener";
    a.click();
}

export const preloadImage = (imgBasePath: string) => {
    const srcSet = [];
    for (let i = 1; i <= 3; i++) {
        srcSet.push(`${imgBasePath}/${i}x.png ${i}x`);
    }
    new Image().srcset = srcSet.join(",");
};

export function openLink(href: string, newTab?: boolean) {
    const a = document.createElement("a");
    a.href = href;
    if (newTab) {
        a.target = "_blank";
    }
    a.rel = "noreferrer noopener";
    a.click();
}

export function isClipboardItemPresent() {
    return typeof ClipboardItem !== "undefined";
}

export function batch<T>(arr: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < arr.length; i += batchSize) {
        batches.push(arr.slice(i, i + batchSize));
    }
    return batches;
}
