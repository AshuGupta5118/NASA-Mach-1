"""Fire-regime regions: the spatial + seasonal skeleton of the global burning record.

Each region is a hand-delineated burning regime (a "fire province") with:
  * a Gaussian-ish spatial footprint (centre + radii + rotation)
  * a seasonal cycle (peak day-of-year, concentration, optional secondary peak)
  * a fire-size distribution (log-normal median cluster FRP, sigma)
  * a land-cover / driver label used by the narrative engine

The footprints are fitted to a real NASA FIRMS 24 h snapshot by
``pipeline/calibrate_real.py`` (see ``data/real_sensor_calibration.json``),
so the simulator reproduces *where* burning actually happens, not a cartoon of it.

Seasonality is encoded as one or two von Mises terms:
    s(doy) = sum_k  w_k * exp( kappa_k * (cos(2*pi*(doy - mu_k)/365.25) - 1) )
which is smooth, periodic and cheap to evaluate.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import List, Tuple

DOY_YEAR = 365.25


@dataclass
class Season:
    """One von Mises seasonal component."""
    mu: float          # peak day of year
    kappa: float       # concentration (higher = shorter, sharper season)
    weight: float = 1.0


@dataclass
class Region:
    key: str
    name: str
    country: str
    lat: float
    lon: float
    rx: float                 # e-W half width (deg)
    ry: float                 # n-S half height (deg)
    tilt: float = 0.0         # rotation of the footprint (deg, + = NE/SW elongated)
    seasons: List[Season] = field(default_factory=list)
    s50: float = 12.0         # median true cluster FRP [MW]
    sigma: float = 1.5        # log-normal sigma of cluster FRP
    driver: str = "agricultural"
    landcover: str = "cropland / grassland"
    weight: float = 1.0       # fitted intensity multiplier
    notes: str = ""

    # ---------------------------------------------------------------- geometry
    def footprint(self, lat: float, lon: float) -> float:
        """Gaussian membership in [0, 1]; 1.0 at the centre."""
        dlat = lat - self.lat
        dlon = (lon - self.lon + 540.0) % 360.0 - 180.0
        t = math.radians(self.tilt)
        c, s = math.cos(t), math.sin(t)
        u = (dlon * c + dlat * s) / self.rx
        v = (-dlon * s + dlat * c) / self.ry
        return math.exp(-0.5 * (u * u + v * v))

    def bbox(self) -> Tuple[float, float, float, float]:
        """(west, south, east, north) covering ~3 sigma of the footprint."""
        k = 3.0
        r = math.hypot(self.rx, self.ry) * k
        return (self.lon - r, self.lat - r, self.lon + r, self.lat + r)

    # ------------------------------------------------------------- seasonality
    def seasonality(self, doy: float) -> float:
        """Normalised seasonal shape, max over the year == 1.0."""
        tot = 0.0
        for c in self.seasons:
            ang = 2.0 * math.pi * (doy - c.mu) / DOY_YEAR
            tot += c.weight * math.exp(c.kappa * (math.cos(ang) - 1.0))
        return tot

    def season_peak(self) -> Tuple[int, float]:
        """(day-of-year of peak, peak value) by brute force over the year."""
        best = max(((d, self.seasonality(d)) for d in range(1, 367)), key=lambda t: t[1])
        return best


S = Season

# --------------------------------------------------------------------------- #
#  Global fire provinces.  ``weight`` starts at 1.0 and is overwritten by the
#  fit against the real FIRMS snapshot.
# --------------------------------------------------------------------------- #
REGIONS: List[Region] = [
    # ---------------------------------------------------------------- S. America
    Region("bra_cerrado", "Brazilian Cerrado", "Brazil", -12.5, -50.0, 7.0, 6.0, 20,
           [S(250, 3.2)], 45.0, 1.9, "agricultural + deforestation",
           "cerrado savanna / pasture",
           notes="World's most intense agricultural burning frontier; Aug-Oct peak."),
    Region("bra_amazon_s", "Southern Amazon arc", "Brazil/Bolivia", -11.0, -60.0, 8.0, 3.5, -10,
           [S(255, 4.0)], 55.0, 2.0, "deforestation",
           "tropical rainforest / cleared land",
           notes="Deforestation fires tied to the dry-season land clearing."),
    Region("bra_amazon_c", "Central Amazon", "Brazil", -4.0, -62.0, 6.0, 4.0, 0,
           [S(270, 3.0)], 38.0, 1.8, "deforestation",
           "tropical rainforest"),
    Region("bol_beni", "Beni / Chaco", "Bolivia/Paraguay", -19.0, -61.0, 5.0, 5.0, 0,
           [S(270, 3.5)], 40.0, 1.8, "agricultural",
           "dry forest / savanna"),
    Region("ven_llanos", "Llanos", "Venezuela/Colombia", 7.0, -69.0, 6.0, 4.0, 0,
           [S(60, 3.5)], 30.0, 1.7, "agricultural",
           "tropical grassland", notes="Dry-season burning Jan-Mar."),
    Region("arg_pampas", "Pampas & Delta", "Argentina", -33.0, -60.0, 5.0, 4.0, 0,
           [S(20, 2.5), S(200, 2.0, 0.6)], 22.0, 1.6, "agricultural",
           "temperate grassland / wetland"),
    Region("chi_central", "Central Chile", "Chile", -36.0, -72.0, 2.5, 4.0, 0,
           [S(20, 3.0)], 25.0, 1.7, "wildfire",
           "mediterranean shrubland"),
    Region("patagonia", "Patagonia", "Argentina/Chile", -45.0, -71.0, 4.0, 4.0, 0,
           [S(15, 3.5)], 18.0, 1.5, "wildfire", "temperate forest / steppe"),
    Region("guiana", "Guiana Shield", "Guyana/Suriname", 4.0, -57.0, 4.0, 3.0, 0,
           [S(280, 3.0)], 25.0, 1.7, "agricultural", "savanna / rainforest"),
    Region("peru_agr", "Peruvian Andes edge", "Peru", -8.0, -76.0, 4.0, 5.0, 0,
           [S(280, 2.5)], 18.0, 1.6, "agricultural", "montane / Amazon fringe"),

    # ------------------------------------------------------------------- Africa
    Region("afr_sahel_w", "West African Sahel", "Mali/Niger/Burkina", 14.0, 2.0, 9.0, 3.0, 0,
           [S(30, 3.5)], 28.0, 1.7, "agricultural",
           "savanna / cropland mosaic", notes="Post-harvest & pastoral burning Dec-Mar."),
    Region("afr_sahel_c", "Central Sahel / Lake Chad", "Chad/Nigeria", 13.0, 14.0, 6.0, 3.5, 0,
           [S(20, 3.5)], 30.0, 1.7, "agricultural", "savanna / wetland"),
    Region("afr_guinea", "Guinean savanna belt", "Côte d'Ivoire-Ghana-Nigeria", 8.5, 2.0, 10.0, 3.0, 0,
           [S(15, 3.0)], 26.0, 1.7, "agricultural", "wooded savanna"),
    Region("afr_congo_n", "Northern Congo basin", "CAR/DRC", 4.0, 22.0, 8.0, 3.0, 0,
           [S(30, 3.0), S(200, 2.5, 0.7)], 24.0, 1.7, "agricultural",
           "savanna / forest edge"),
    Region("afr_congo_s", "Southern Congo basin", "DRC/Angola", -8.0, 22.0, 8.0, 5.0, 0,
           [S(220, 3.0)], 26.0, 1.7, "agricultural", "miombo woodland",
           notes="One of the largest single burning areas on Earth (Angola/DRC)."),
    Region("afr_angola", "Angolan plateau", "Angola", -12.0, 18.0, 5.0, 3.5, 0,
           [S(230, 3.5)], 24.0, 1.6, "agricultural", "grassland / woodland"),
    Region("afr_zambezi", "Zambezi / southern miombo", "Zambia/Malawi/Mozambique", -14.0, 32.0, 7.0, 4.0, 0,
           [S(260, 3.0)], 22.0, 1.6, "agricultural", "miombo woodland"),
    Region("afr_ethiop", "Ethiopian highlands & savanna", "Ethiopia/Sudan", 10.0, 34.0, 6.0, 5.0, 0,
           [S(40, 2.5), S(320, 2.5, 0.6)], 22.0, 1.6, "agricultural", "cropland / savanna"),
    Region("afr_south", "Southern Africa veld", "South Africa/Zimbabwe", -27.0, 27.0, 5.0, 4.0, 0,
           [S(250, 3.0)], 20.0, 1.6, "agricultural", "grassland / shrubland"),
    Region("afr_madag", "Madagascar", "Madagascar", -20.0, 46.5, 3.0, 5.0, 0,
           [S(280, 3.0)], 22.0, 1.7, "agricultural", "grassland / dry forest"),
    Region("afr_horn", "Horn of Africa", "Somalia/Kenya", 3.0, 44.0, 6.0, 5.0, 0,
           [S(60, 2.5)], 16.0, 1.5, "pastoral", "arid savanna"),

    # --------------------------------------------------------------------- Asia
    Region("ind_gangetic", "Indo-Gangetic Plain", "India/Pakistan", 27.0, 79.0, 7.0, 3.0, 0,
           [S(300, 5.0), S(120, 4.0, 0.35)], 20.0, 1.8, "crop-residue",
           "cropland", notes="Paddy-residue burning drives the Oct-Nov Delhi smoke episode."),
    Region("ind_peninsula", "Peninsular India", "India", 17.0, 77.0, 6.0, 5.0, 0,
           [S(60, 2.5), S(300, 2.5, 0.6)], 18.0, 1.7, "agricultural", "cropland / dry forest"),
    Region("se_asia_main", "Mainland SE Asia", "Myanmar/Thailand/Laos/Vietnam", 19.0, 99.0, 6.0, 6.0, 0,
           [S(80, 4.0)], 20.0, 1.7, "agricultural + forest",
           "dry deciduous forest / cropland", notes="Feb-Apr burning season, strongly ENSO-modulated."),
    Region("sumatra", "Sumatra peatlands", "Indonesia", 0.5, 101.5, 3.5, 4.5, 0,
           [S(210, 3.0), S(60, 2.5, 0.5)], 30.0, 1.9, "peat / plantation",
           "peat swamp / oil palm", notes="Peat fires: very high FRP, persistent smouldering."),
    Region("borneo", "Borneo peatlands", "Indonesia/Malaysia", -1.5, 113.0, 4.5, 3.5, 0,
           [S(220, 3.0), S(60, 2.5, 0.4)], 32.0, 1.9, "peat / plantation",
           "peat swamp / oil palm"),
    Region("java_bali", "Java & Bali", "Indonesia", -7.6, 111.5, 5.0, 1.2, 0,
           [S(250, 3.5)], 14.0, 1.6, "crop-residue", "cropland"),
    Region("philippines", "Philippines", "Philippines", 12.0, 122.5, 3.0, 5.0, 0,
           [S(90, 3.0)], 16.0, 1.6, "agricultural", "cropland / forest"),
    Region("china_north", "North China Plain", "China", 36.0, 115.0, 5.0, 3.0, 0,
           [S(160, 5.0), S(290, 4.0, 0.5)], 16.0, 1.7, "crop-residue", "cropland"),
    Region("china_ne", "Northeast China", "China", 46.0, 126.0, 5.0, 4.0, 0,
           [S(115, 4.0), S(285, 3.5, 0.45)], 22.0, 1.7, "crop-residue + forest", "cropland / forest"),
    Region("mongolia", "Mongolian steppe", "Mongolia", 46.5, 103.0, 7.0, 4.0, 0,
           [S(105, 4.0), S(270, 3.0, 0.35)], 40.0, 1.9, "grassland wildfire",
           "steppe", notes="Fast-moving spring grass fires."),
    Region("siberia_w", "West Siberia / taiga", "Russia", 60.0, 80.0, 10.0, 6.0, 0,
           [S(195, 5.0)], 60.0, 2.1, "boreal wildfire",
           "boreal forest / peatland", notes="Boreal summer season; extreme-fire years dominate emissions."),
    Region("siberia_e", "East Siberia / Yakutia", "Russia", 62.0, 125.0, 12.0, 6.0, 0,
           [S(190, 5.0)], 70.0, 2.2, "boreal wildfire", "boreal forest / permafrost"),
    Region("russ_far_east", "Russian Far East", "Russia", 50.0, 135.0, 7.0, 5.0, 0,
           [S(115, 3.5), S(250, 3.0, 0.5)], 45.0, 1.9, "grassland + forest", "forest / steppe"),
    Region("kazakh_steppe", "Kazakh steppe", "Kazakhstan", 48.0, 66.0, 8.0, 4.0, 0,
           [S(120, 4.0), S(250, 3.0, 0.4)], 35.0, 1.8, "grassland wildfire", "steppe"),
    Region("middle_east", "Fertile Crescent / Anatolia", "Türkiye/Iraq/Iran", 35.5, 44.0, 9.0, 5.0, 0,
           [S(200, 3.5)], 22.0, 1.7, "agricultural + wildfire", "cropland / shrubland"),
    Region("iran_afghan", "Iran-Afghanistan-Pakistan belt", "Iran/Afghanistan", 31.0, 62.0, 8.0, 5.0, 0,
           [S(190, 3.0)], 20.0, 1.6, "agricultural", "cropland / rangeland"),
    Region("himalaya_foothills", "Himalayan foothills", "Nepal/N. India", 28.0, 84.0, 5.0, 1.8, 0,
           [S(110, 4.0), S(310, 3.0, 0.5)], 18.0, 1.6, "forest + agricultural", "montane forest"),

    # ------------------------------------------------------- Australia / Oceania
    Region("aus_north", "Northern Australia (Top End)", "Australia", -15.0, 132.0, 8.0, 3.5, 0,
           [S(250, 4.0)], 35.0, 1.9, "savanna",
           "tropical savanna", notes="Extensive prescribed + wild savanna burning May-Oct."),
    Region("aus_east", "Eastern Australia", "Australia", -31.0, 150.0, 4.0, 5.0, 0,
           [S(350, 2.5), S(180, 2.0, 0.35)], 28.0, 1.8, "wildfire",
           "eucalypt forest", notes="Black Summer 2019-20 was an extreme anomaly here."),
    Region("aus_south_west", "South-West Australia", "Australia", -32.0, 118.0, 4.0, 3.0, 0,
           [S(340, 3.0)], 24.0, 1.7, "wildfire", "eucalypt forest / shrubland"),
    Region("nz", "New Zealand", "New Zealand", -42.0, 172.0, 2.5, 4.0, 0,
           [S(30, 3.0)], 14.0, 1.5, "agricultural + wildfire", "grassland"),
    Region("png", "Papua New Guinea", "Papua New Guinea", -6.5, 145.0, 4.0, 2.5, 0,
           [S(250, 3.0)], 20.0, 1.7, "agricultural", "tropical forest / grassland"),

    # ------------------------------------------------------------- N. America
    Region("us_west", "Western USA", "USA", 41.0, -118.0, 7.0, 6.0, 0,
           [S(215, 3.5)], 35.0, 2.0, "wildfire",
           "conifer forest / shrubland", notes="Aug-Sep mega-fire season; 2020 & 2021 were extremes."),
    Region("us_south", "Southern USA", "USA", 31.5, -88.0, 6.0, 3.0, 0,
           [S(80, 3.0), S(300, 2.5, 0.4)], 20.0, 1.7, "prescribed + agricultural",
           "pine / cropland"),
    Region("us_midwest", "US Midwest / Great Plains", "USA", 42.0, -96.0, 6.0, 4.0, 0,
           [S(90, 4.0), S(300, 3.0, 0.45)], 18.0, 1.7, "crop-residue + grassland", "cropland / prairie"),
    Region("us_southeast_ag", "Southeast US agricultural belt", "USA", 34.5, -82.0, 3.5, 2.5, 0,
           [S(120, 3.0)], 14.0, 1.5, "agricultural", "cropland"),
    Region("canada_boreal_w", "Canadian western boreal", "Canada", 55.0, -122.0, 8.0, 5.0, 0,
           [S(195, 5.0)], 65.0, 2.1, "boreal wildfire", "boreal forest",
           notes="2023 was the largest Canadian fire season on record."),
    Region("canada_boreal_e", "Canadian eastern boreal", "Canada", 52.0, -78.0, 8.0, 5.0, 0,
           [S(195, 5.0)], 60.0, 2.1, "boreal wildfire", "boreal forest"),
    Region("alaska", "Alaska", "USA", 64.0, -150.0, 8.0, 4.0, 0,
           [S(180, 5.0)], 55.0, 2.0, "boreal wildfire", "boreal forest / tundra"),
    Region("mexico_central", "Mexico & Central America", "Mexico", 20.0, -100.0, 7.0, 5.0, 0,
           [S(120, 4.0)], 22.0, 1.7, "agricultural + forest", "dry forest / cropland"),
    Region("caribbean", "Caribbean", "Cuba/Hispaniola", 20.0, -75.0, 5.0, 2.0, 0,
           [S(60, 3.0)], 16.0, 1.6, "agricultural", "cropland / dry forest"),

    # ------------------------------------------------------------------- Europe
    Region("med_iberia", "Iberia", "Spain/Portugal", 40.0, -5.0, 3.5, 2.5, 0,
           [S(215, 3.5)], 22.0, 1.7, "wildfire + agricultural", "mediterranean shrubland"),
    Region("med_balkans", "Balkans & Italy", "Italy/Balkans", 42.0, 15.0, 4.5, 3.0, 0,
           [S(210, 3.5)], 18.0, 1.6, "wildfire + agricultural", "mediterranean shrubland"),
    Region("med_greece", "Greece & Aegean", "Greece/Türkiye", 39.0, 23.0, 2.5, 2.0, 0,
           [S(210, 4.0)], 22.0, 1.7, "wildfire", "mediterranean shrubland"),
    Region("europe_north", "Northern & Eastern Europe", "Scandinavia/Baltics/Belarus", 58.0, 26.0, 8.0, 5.0, 0,
           [S(190, 4.0)], 20.0, 1.6, "forest + peat", "boreal forest / peatland"),
    Region("uk_heather", "British Isles uplands", "UK/Ireland", 54.5, -3.5, 2.5, 2.5, 0,
           [S(80, 4.0), S(290, 3.0, 0.5)], 10.0, 1.5, "heather burning", "moorland"),

    # ------------------------------------------------------------- background
    Region("global_background", "Diffuse global background", "global", 0.0, 0.0, 180.0, 90.0, 0,
           [S(1, 0.0)], 8.0, 1.4, "mixed", "mixed",
           notes="Low-level, non-regional burning that fills in the gaps."),
]

BY_KEY = {r.key: r for r in REGIONS}


def region_footprints(lat, lon):
    """Yield (region, membership) for every region that covers (lat, lon)."""
    for r in REGIONS:
        f = r.footprint(lat, lon)
        if f > 1e-4:
            yield r, f


def dominant_region(lat, lon):
    """The single region that best explains (lat, lon)."""
    best, bestf = None, 0.0
    for r in REGIONS:
        f = r.footprint(lat, lon)
        if f > bestf:
            best, bestf = r, f
    return best, bestf
