import { CustomHead } from "@/next/components/Head";
import { setupI18n } from "@/next/i18n";
import { APPS, APP_TITLES } from "@ente/shared/apps/constants";
import { Overlay } from "@ente/shared/components/Container";
import DialogBoxV2 from "@ente/shared/components/DialogBoxV2";
import {
    DialogBoxAttributesV2,
    SetDialogBoxAttributesV2,
} from "@ente/shared/components/DialogBoxV2/types";
import EnteSpinner from "@ente/shared/components/EnteSpinner";
import AppNavbar from "@ente/shared/components/Navbar/app";
import { useLocalState } from "@ente/shared/hooks/useLocalState";
import HTTPService from "@ente/shared/network/HTTPService";
import { LS_KEYS, getData } from "@ente/shared/storage/localStorage";
import { getTheme } from "@ente/shared/themes";
import { THEME_COLOR } from "@ente/shared/themes/constants";
import { CssBaseline, useMediaQuery } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import { t } from "i18next";
import { AppProps } from "next/app";
import { useRouter } from "next/router";
import { createContext, useEffect, useState } from "react";
import "styles/global.css";

interface AppContextProps {
    isMobile: boolean;
    showNavBar: (show: boolean) => void;
    setDialogBoxAttributesV2: SetDialogBoxAttributesV2;
}

export const AppContext = createContext<AppContextProps>({} as AppContextProps);

export default function App({ Component, pageProps }: AppProps) {
    const [isI18nReady, setIsI18nReady] = useState<boolean>(false);

    const [showNavbar, setShowNavBar] = useState(false);

    const [dialogBoxAttributeV2, setDialogBoxAttributesV2] =
        useState<DialogBoxAttributesV2>();

    const [dialogBoxV2View, setDialogBoxV2View] = useState(false);

    useEffect(() => {
        setDialogBoxV2View(true);
    }, [dialogBoxAttributeV2]);

    const showNavBar = (show: boolean) => setShowNavBar(show);

    const isMobile = useMediaQuery("(max-width:428px)");

    const router = useRouter();

    const [themeColor] = useLocalState(LS_KEYS.THEME, THEME_COLOR.DARK);

    useEffect(() => {
        setupI18n().finally(() => setIsI18nReady(true));
    }, []);

    const setupPackageName = () => {
        const pkg = getData(LS_KEYS.CLIENT_PACKAGE);
        if (!pkg) return;
        HTTPService.setHeaders({
            "X-Client-Package": pkg.name,
        });
    };

    useEffect(() => {
        router.events.on("routeChangeComplete", setupPackageName);
        return () => {
            router.events.off("routeChangeComplete", setupPackageName);
        };
    }, [router.events]);

    const closeDialogBoxV2 = () => setDialogBoxV2View(false);

    const theme = getTheme(themeColor, APPS.PHOTOS);

    const title = isI18nReady
        ? t("TITLE", { context: APPS.ACCOUNTS })
        : APP_TITLES.get(APPS.ACCOUNTS);

    return (
        <>
            <CustomHead {...{ title }} />

            <ThemeProvider theme={theme}>
                <CssBaseline enableColorScheme />
                <DialogBoxV2
                    sx={{ zIndex: 1600 }}
                    open={dialogBoxV2View}
                    onClose={closeDialogBoxV2}
                    attributes={dialogBoxAttributeV2 as any}
                />

                <AppContext.Provider
                    value={{
                        isMobile,
                        showNavBar,
                        setDialogBoxAttributesV2:
                            setDialogBoxAttributesV2 as any,
                    }}
                >
                    {!isI18nReady && (
                        <Overlay
                            sx={(theme) => ({
                                display: "flex",
                                justifyContent: "center",
                                alignItems: "center",
                                zIndex: 2000,
                                backgroundColor: (theme as any).colors
                                    .background.base,
                            })}
                        >
                            <EnteSpinner />
                        </Overlay>
                    )}
                    {showNavbar && <AppNavbar isMobile={isMobile} />}
                    {isI18nReady && <Component {...pageProps} />}
                </AppContext.Provider>
            </ThemeProvider>
        </>
    );
}
