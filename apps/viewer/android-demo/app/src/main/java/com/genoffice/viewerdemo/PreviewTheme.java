package com.genoffice.viewerdemo;

/** Default to light; system following is an explicit user choice. */
final class PreviewTheme {
    private PreviewTheme() { }
    static String normalize(String choice) {
        return "dark".equals(choice) || "system".equals(choice) ? choice : "light";
    }
    static String resolve(String choice, boolean night) {
        return "system".equals(normalize(choice)) ? (night ? "dark" : "light") : normalize(choice);
    }
}
