import log from "@/next/log";
import { ApiError } from "../error";
import { getToken } from "../storage/localStorage/helpers";
import HTTPService from "./HTTPService";
import { getEndpoint } from "./api";

class CastGateway {
    constructor() {}

    public async getCastData(code: string): Promise<string | null> {
        let resp;
        try {
            resp = await HTTPService.get(
                `${getEndpoint()}/cast/cast-data/${code}`,
            );
        } catch (e) {
            log.error("failed to getCastData", e);
            throw e;
        }
        return resp.data.encCastData;
    }

    public async revokeAllTokens() {
        try {
            const token = getToken();
            await HTTPService.delete(
                getEndpoint() + "/cast/revoke-all-tokens/",
                undefined,
                undefined,
                {
                    "X-Auth-Token": token,
                },
            );
        } catch (e) {
            log.error("removeAllTokens failed", e);
            // swallow error
        }
    }

    public async getPublicKey(code: string): Promise<string> {
        let resp;
        try {
            const token = getToken();
            resp = await HTTPService.get(
                `${getEndpoint()}/cast/device-info/${code}`,
                undefined,
                {
                    "X-Auth-Token": token,
                },
            );
        } catch (e) {
            if (e instanceof ApiError && e.httpStatusCode === 404) {
                return "";
            }
            log.error("failed to getPublicKey", e);
            throw e;
        }
        return resp.data.publicKey;
    }

    public async registerDevice(code: string, publicKey: string) {
        await HTTPService.post(getEndpoint() + "/cast/device-info/", {
            deviceCode: `${code}`,
            publicKey: publicKey,
        });
    }

    public async publishCastPayload(
        code: string,
        castPayload: string,
        collectionID: number,
        castToken: string,
    ) {
        const token = getToken();
        await HTTPService.post(
            getEndpoint() + "/cast/cast-data/",
            {
                deviceCode: `${code}`,
                encPayload: castPayload,
                collectionID: collectionID,
                castToken: castToken,
            },
            undefined,
            { "X-Auth-Token": token },
        );
    }
}

export default new CastGateway();
