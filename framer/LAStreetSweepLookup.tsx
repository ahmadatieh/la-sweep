import { addPropertyControls, ControlType } from "framer"
import { useState, CSSProperties } from "react"

/**
 * LA Street Sweep Lookup — Framer code component.
 *
 * Drop this into a Framer Code File (Assets → + → New Code File) and place
 * the resulting component anywhere on your site. It calls the `la-sweep`
 * Node backend at `apiUrl` and renders matching sweeping schedules with
 * a one-click "Add to Google Calendar" button per schedule.
 */

interface Props {
    apiUrl: string
    placeholder: string
    buttonLabel: string
    calendarButtonLabel: string
    accentColor: string
    backgroundColor: string
    cardBackground: string
    textColor: string
    mutedColor: string
    borderColor: string
    errorBackground: string
    errorColor: string
    borderRadius: number
    fontFamily: string
    maxWidth: number
}

const DAY_NAMES = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
]

type Schedule = {
    routeNo: string
    dayIndex: number | null
    dayAbbr: string
    startTime: string
    endTime: string
    boundaries: string
    councilDistrict: string
    nextSweep: { start: string; end: string } | null
    gcalUrl: string | null
}

type LookupResult = {
    matchedAddress: string
    coordinates: { lat: number; lng: number }
    schedules: Schedule[]
}

function formatLA(iso: string) {
    return new Date(iso).toLocaleString("en-US", {
        timeZone: "America/Los_Angeles",
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    })
}

export default function LAStreetSweepLookup(props: Props) {
    const {
        apiUrl,
        placeholder,
        buttonLabel,
        calendarButtonLabel,
        accentColor,
        backgroundColor,
        cardBackground,
        textColor,
        mutedColor,
        borderColor,
        errorBackground,
        errorColor,
        borderRadius,
        fontFamily,
        maxWidth,
    } = props

    const [address, setAddress] = useState("")
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState("")
    const [result, setResult] = useState<LookupResult | null>(null)

    async function onSubmit(e: React.FormEvent) {
        e.preventDefault()
        const trimmed = address.trim()
        if (!trimmed) return
        setLoading(true)
        setError("")
        setResult(null)
        try {
            const endpoint = apiUrl.replace(/\/+$/, "") + "/api/lookup"
            const res = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ address: trimmed }),
            })
            const data = await res.json()
            if (!res.ok) {
                throw new Error(
                    data.error || `Request failed (${res.status})`
                )
            }
            setResult(data)
        } catch (err: any) {
            setError(err?.message || "Something went wrong.")
        } finally {
            setLoading(false)
        }
    }

    // --- styles ---
    const root: CSSProperties = {
        width: "100%",
        maxWidth,
        margin: "0 auto",
        background: backgroundColor,
        color: textColor,
        fontFamily,
        padding: 24,
        boxSizing: "border-box",
        borderRadius,
    }

    const formStyle: CSSProperties = {
        display: "flex",
        gap: 8,
        marginBottom: 16,
    }

    const inputStyle: CSSProperties = {
        flex: 1,
        padding: "12px 14px",
        fontSize: 16,
        border: `1px solid ${borderColor}`,
        borderRadius,
        background: cardBackground,
        color: textColor,
        fontFamily: "inherit",
        outline: "none",
    }

    const buttonStyle: CSSProperties = {
        padding: "12px 18px",
        fontSize: 16,
        fontWeight: 600,
        color: "#fff",
        background: accentColor,
        border: "none",
        borderRadius,
        cursor: loading ? "not-allowed" : "pointer",
        opacity: loading || !address.trim() ? 0.5 : 1,
        fontFamily: "inherit",
    }

    const errorStyle: CSSProperties = {
        padding: "12px 14px",
        borderRadius,
        background: errorBackground,
        color: errorColor,
        marginBottom: 16,
    }

    const matchedStyle: CSSProperties = {
        fontSize: 14,
        color: mutedColor,
        marginBottom: 16,
    }

    const labelStyle: CSSProperties = {
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: mutedColor,
        marginRight: 4,
    }

    const cardStyle: CSSProperties = {
        background: cardBackground,
        border: `1px solid ${borderColor}`,
        borderRadius,
        padding: "16px 18px",
        marginBottom: 12,
    }

    const cardHeadStyle: CSSProperties = {
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 12,
        marginBottom: 8,
    }

    const gcalStyle: CSSProperties = {
        display: "inline-block",
        padding: "8px 14px",
        background: "#111",
        color: "#fff",
        borderRadius,
        textDecoration: "none",
        fontSize: 14,
        fontWeight: 600,
    }

    return (
        <div style={root}>
            <form style={formStyle} onSubmit={onSubmit}>
                <input
                    style={inputStyle}
                    type="text"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder={placeholder}
                />
                <button
                    style={buttonStyle}
                    type="submit"
                    disabled={loading || !address.trim()}
                >
                    {loading ? "Looking up…" : buttonLabel}
                </button>
            </form>

            {error && <div style={errorStyle}>{error}</div>}

            {result && (
                <div>
                    <div style={matchedStyle}>
                        <span style={labelStyle}>Matched address</span>
                        {result.matchedAddress}
                    </div>

                    {result.schedules.length === 0 ? (
                        <div
                            style={{
                                padding: 16,
                                borderRadius,
                                background: errorBackground,
                                color: errorColor,
                                lineHeight: 1.5,
                            }}
                        >
                            No posted sweeping route found nearby. Parking is
                            likely fine here — but double-check the signs on
                            your block.
                        </div>
                    ) : (
                        <>
                            <h2
                                style={{
                                    fontSize: 16,
                                    margin: "0 0 12px",
                                    color: textColor,
                                }}
                            >
                                Found {result.schedules.length} schedule
                                {result.schedules.length === 1 ? "" : "s"}{" "}
                                nearby
                            </h2>
                            {result.schedules.map((s, i) => (
                                <div key={i} style={cardStyle}>
                                    <div style={cardHeadStyle}>
                                        <div
                                            style={{
                                                fontSize: 18,
                                                fontWeight: 600,
                                            }}
                                        >
                                            {s.dayIndex != null
                                                ? DAY_NAMES[s.dayIndex]
                                                : "Unknown day"}
                                        </div>
                                        <div
                                            style={{
                                                color: mutedColor,
                                                fontVariantNumeric:
                                                    "tabular-nums",
                                            }}
                                        >
                                            {s.startTime} – {s.endTime}
                                        </div>
                                    </div>
                                    <div
                                        style={{
                                            display: "flex",
                                            gap: 16,
                                            fontSize: 14,
                                            marginBottom: 8,
                                        }}
                                    >
                                        <div>
                                            <span style={labelStyle}>
                                                Route
                                            </span>
                                            {s.routeNo || "—"}
                                        </div>
                                        {s.councilDistrict && (
                                            <div>
                                                <span style={labelStyle}>
                                                    CD
                                                </span>
                                                {s.councilDistrict}
                                            </div>
                                        )}
                                    </div>
                                    {s.boundaries && (
                                        <div
                                            style={{
                                                fontSize: 13,
                                                color: mutedColor,
                                                marginBottom: 12,
                                                lineHeight: 1.5,
                                            }}
                                        >
                                            {s.boundaries}
                                        </div>
                                    )}
                                    {s.nextSweep && (
                                        <div
                                            style={{
                                                padding: "10px 12px",
                                                background: backgroundColor,
                                                borderRadius,
                                                marginBottom: 12,
                                            }}
                                        >
                                            <div style={labelStyle}>
                                                Next sweep
                                            </div>
                                            <div
                                                style={{
                                                    fontVariantNumeric:
                                                        "tabular-nums",
                                                    marginTop: 2,
                                                }}
                                            >
                                                {formatLA(s.nextSweep.start)}{" "}
                                                → {formatLA(s.nextSweep.end)}
                                            </div>
                                        </div>
                                    )}
                                    {s.gcalUrl && (
                                        <a
                                            style={gcalStyle}
                                            href={s.gcalUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                        >
                                            {calendarButtonLabel}
                                        </a>
                                    )}
                                </div>
                            ))}
                        </>
                    )}
                </div>
            )}
        </div>
    )
}

LAStreetSweepLookup.displayName = "LA Street Sweep Lookup"

LAStreetSweepLookup.defaultProps = {
    apiUrl: "https://your-api.example.com",
    placeholder: "1234 Sunset Blvd, Los Angeles, CA",
    buttonLabel: "Look up",
    calendarButtonLabel: "Add to Google Calendar",
    accentColor: "#0F62FE",
    backgroundColor: "#FAFAF7",
    cardBackground: "#FFFFFF",
    textColor: "#1C1C1C",
    mutedColor: "#6B6B6B",
    borderColor: "#E4E4DF",
    errorBackground: "#FDE8E8",
    errorColor: "#7A1111",
    borderRadius: 8,
    fontFamily:
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    maxWidth: 560,
}

addPropertyControls(LAStreetSweepLookup, {
    apiUrl: {
        type: ControlType.String,
        title: "API URL",
        placeholder: "https://your-api.onrender.com",
        description: "Base URL of your deployed la-sweep Node backend.",
    },
    placeholder: {
        type: ControlType.String,
        title: "Input placeholder",
    },
    buttonLabel: {
        type: ControlType.String,
        title: "Button label",
    },
    calendarButtonLabel: {
        type: ControlType.String,
        title: "Calendar label",
    },
    maxWidth: {
        type: ControlType.Number,
        title: "Max width",
        min: 320,
        max: 1200,
        step: 10,
        unit: "px",
    },
    borderRadius: {
        type: ControlType.Number,
        title: "Radius",
        min: 0,
        max: 32,
        step: 1,
        unit: "px",
    },
    fontFamily: {
        type: ControlType.String,
        title: "Font family",
    },
    accentColor: {
        type: ControlType.Color,
        title: "Accent",
    },
    backgroundColor: {
        type: ControlType.Color,
        title: "Background",
    },
    cardBackground: {
        type: ControlType.Color,
        title: "Card bg",
    },
    textColor: {
        type: ControlType.Color,
        title: "Text",
    },
    mutedColor: {
        type: ControlType.Color,
        title: "Muted",
    },
    borderColor: {
        type: ControlType.Color,
        title: "Border",
    },
    errorBackground: {
        type: ControlType.Color,
        title: "Error bg",
    },
    errorColor: {
        type: ControlType.Color,
        title: "Error text",
    },
})
