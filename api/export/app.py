"""GET /api/export?bbox=W,S,E,N&from=YYYY-MM-DD&to=YYYY-MM-DD&source=VIIRS_NOAA20_NRT

CSV of raw FIRMS hotspots for a bounding box and a short date range (at most
31 days). Long historical exports are assembled in the browser from the static
yearly files produced by the pipeline, so this endpoint never loops over years.
"""
import csv
import datetime as dt
import io

from common import BadRequest, cache_get, cache_put, guarded, parse_bbox, parse_date, query, response
from common.firms import EXPORT_SOURCES, area_csv

MAX_DAYS = 31
COLUMNS = ["latitude", "longitude", "acq_date", "acq_time", "satellite", "instrument", "confidence", "frp", "daynight"]


@guarded
def handler(event, context=None):
    q = query(event)
    bbox = parse_bbox(q.get("bbox"))
    start, end = parse_date(q.get("from"), "from"), parse_date(q.get("to"), "to")
    source = q.get("source", "VIIRS_NOAA20_NRT")
    if source not in EXPORT_SOURCES:
        raise BadRequest("source must be one of: " + ", ".join(EXPORT_SOURCES))
    if end < start:
        raise BadRequest("'to' must not be before 'from'")
    if (end - start).days + 1 > MAX_DAYS:
        raise BadRequest(f"date range too long (limit {MAX_DAYS} days); use the yearly files for history")
    if end > dt.datetime.now(dt.timezone.utc).date():
        raise BadRequest("'to' is in the future")

    key = f"export/{source}/" + "_".join(f"{v:g}" for v in bbox) + f"_{start}_{end}.json"
    # standard-processing data never changes; NRT is refreshed after 15 minutes
    rows = cache_get(key, None if source.endswith("_SP") else 15 * 60)
    if rows is None:
        rows, day = [], start
        while day <= end:
            n = min(5, (end - day).days + 1)
            rows += area_csv(source, bbox, n, day)
            day += dt.timedelta(days=n)
        rows = [{c: r.get(c, "") for c in COLUMNS} for r in rows]
        cache_put(key, rows)

    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=COLUMNS, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    res = response(200, out.getvalue(), content_type="text/csv")
    res["headers"]["Content-Disposition"] = f'attachment; filename="fireledger_{source}_{start}_{end}.csv"'
    return res
