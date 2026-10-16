# Harmonisation validation

Record: **2001-01-01 to 2025-12-31** (9,131 days), global, 0.25&deg; daily.

The simulator retains the latent number of true burning clusters; the harmoniser only ever sees the two sensors' detections. Every number below compares a harmonised estimate against that retained truth.

## Headline

- Global bias of the harmonised series: **-0.57%** (raw MODIS -60.8%, naive sum +151.4%).
- Normalised RMSE: **6.5%** vs 288% for the naive sum and 68% for raw MODIS.
- Daily correlation with truth: **r = 0.9916**, rho = 0.9877.
- Empirical bridge factor for the pre-VIIRS era: **beta = 0.9952** (1.0 would mean the two inversions already agree).

## Estimator comparison (global daily counts)

| estimator | bias % | NRMSE % | MAE | Pearson r | Spearman rho |
|---|---:|---:|---:|---:|---:|
| raw MODIS count | -60.82 | 68.00 | 37,854 | 0.9509 | 0.9111 |
| raw VIIRS count | +275.52 | 334.97 | 173,179 | 0.7330 | 0.7485 |
| naive MODIS+VIIRS sum | +151.39 | 287.79 | 128,229 | 0.4743 | 0.3885 |
| harmonised (bridge, no platform correction) | +27.96 | 67.38 | 22,646 | 0.6957 | 0.6983 |
| harmonised (full) | -0.57 | 6.45 | 552 | 0.9916 | 0.9877 |
| harmonised (no quality control) | -0.87 | 8.02 | 734 | 0.9870 | 0.9807 |

*Raw VIIRS is scored only from 2012 onwards, when it exists.*

## Artificial steps at observing-system changes

Percentage jump in the 180 days after each platform change relative to the 180 days before. A step here is an artefact of the observing system, not a change in burning.

| boundary | date | truth | raw MODIS | raw VIIRS | naive sum | **harmonised** |
|---|---|---:|---:|---:|---:|---:|
| Aqua joins Terra (MODIS 1->2 sats) | 2002-07-04 | +28.2% | +176.9% | +0.0% | +176.9% | **+12.6%** |
| VIIRS operational (MODIS -> MODIS+VIIRS) | 2012-01-01 | +9.4% | +9.5% | +13105801111111112.0% | +654.9% | **+10.0%** |
| NOAA-20 joins VIIRS (1->2 sats) | 2018-01-01 | -17.6% | -17.7% | +53.8% | +43.5% | **-17.7%** |
| NOAA-21 joins VIIRS (2->3 sats) | 2024-01-01 | -36.6% | -36.6% | -9.7% | -11.9% | **-36.5%** |

## Sensor outages

Synthetic safe-mode windows were injected into the record. Because the harmoniser fuses both sensors, a dropout in one is largely absorbed.

| sensor | window | injected retention | harmonised bias during window |
|---|---|---:|---:|
| MODIS | 2002-07-01 .. 2002-07-14 | 0.45 | -76.2% |
| MODIS | 2020-06-15 .. 2020-06-29 | 0.55 | +0.0% |
| VIIRS | 2014-02-06 .. 2014-02-19 | 0.25 | -0.2% |
| VIIRS | 2019-02-03 .. 2019-02-11 | 0.30 | -0.0% |
| VIIRS | 2020-08-04 .. 2020-08-09 | 0.35 | -0.1% |
| VIIRS | 2023-05-12 .. 2023-05-20 | 0.40 | +0.1% |

## Per-province accuracy (annual totals)

| province | bias % | Pearson r | Spearman rho |
|---|---:|---:|---:|
| borneo | -0.76 | 0.9985 | 0.9992 |
| sumatra | -0.76 | 0.9987 | 0.9977 |
| middle_east | -1.04 | 0.9756 | 0.9400 |
| afr_sahel_c | -0.25 | 1.0000 | 0.9985 |
| afr_sahel_w | -0.25 | 1.0000 | 0.9992 |
| afr_zambezi | -0.34 | 0.9996 | 0.9992 |
| mexico_central | -0.34 | 0.9993 | 0.9992 |
| ven_llanos | -0.23 | 0.9999 | 1.0000 |
| siberia_w | -1.38 | 0.9864 | 0.9577 |
| us_southeast_ag | -0.48 | 0.9949 | 0.9715 |
| afr_congo_s | -0.78 | 0.9914 | 0.9723 |
| global_background | -0.38 | 0.9978 | 0.9992 |
| se_asia_main | -0.26 | 1.0000 | 1.0000 |
| iran_afghan | -0.77 | 0.9783 | 0.9654 |
| afr_ethiop | -0.22 | 0.9998 | 0.9992 |
| bra_cerrado | -0.41 | 0.9991 | 0.9992 |

## Long-term trend

| series | trend %/yr |
|---|---:|
| true | -0.14 |
| harmonised | -0.04 |
| raw modis | +0.73 |
| naive sum | +10.87 |

The naive MODIS+VIIRS sum is dominated by the 2012 / 2018 / 2024 platform steps and therefore reports a trend that is an artefact. The harmonised series tracks the true trend.

## Extreme-season detection

34 of 41 injected extreme fire seasons were recovered at province level with an anomaly z-score above 1.5.

| province | year | months | injected x | anomaly z | detected |
|---|---|---|---:|---:|---|
| png | 2015 | 8,9,10 | 1.8 | +8.03 | yes |
| med_greece | 2018 | 7 | 2.0 | +7.58 | yes |
| chi_central | 2017 | 1,2 | 2.0 | +7.38 | yes |
| aus_east | 2019 | 11,12 | 3.5 | +6.46 | yes |
| siberia_w | 2010 | 7,8 | 2.6 | +5.62 | yes |
| java_bali | 2015 | 9,10 | 1.5 | +5.02 | yes |
| europe_north | 2010 | 7,8 | 2.2 | +4.88 | yes |
| sumatra | 2015 | 8,9,10,11 | 2.4 | +4.56 | yes |
| canada_boreal_e | 2023 | 5,6,7,8,9 | 3.0 | +4.47 | yes |
| bol_beni | 2019 | 9,10 | 2.2 | +4.47 | yes |
| canada_boreal_w | 2016 | 5 | 2.0 | +4.20 | yes |
| bra_amazon_s | 2010 | 8,9 | 1.8 | +3.67 | yes |
| borneo | 2015 | 8,9,10,11 | 2.6 | +3.17 | yes |
| med_iberia | 2017 | 10 | 2.0 | +3.11 | yes |
| aus_east | 2020 | 1,2 | 3.0 | +2.94 | yes |
| us_west | 2025 | 1 | 1.9 | +2.90 | yes |
| siberia_e | 2019 | 7,8 | 1.9 | +2.72 | yes |
| us_west | 2020 | 8,9,10 | 2.6 | +2.59 | yes |
| canada_boreal_w | 2023 | 5,6,7,8,9 | 3.2 | +2.53 | yes |
| med_balkans | 2021 | 8 | 2.0 | +2.48 | yes |
| mongolia | 2022 | 4,5 | 1.8 | +2.47 | yes |
| med_iberia | 2003 | 8 | 2.2 | +2.29 | yes |
| med_greece | 2007 | 8 | 2.5 | +2.04 | yes |
| afr_congo_s | 2016 | 8,9 | 1.4 | +1.97 | yes |
| bra_cerrado | 2017 | 9,10 | 1.7 | +1.91 | yes |
| us_west | 2018 | 8,9 | 1.8 | +1.86 | yes |
| bol_beni | 2024 | 9,10 | 2.4 | +1.75 | yes |
| bra_amazon_c | 2010 | 8,9 | 1.7 | +1.70 | yes |
| med_iberia | 2022 | 7,8 | 1.8 | +1.66 | yes |
| uk_heather | 2019 | 3,4 | 1.5 | +1.64 | yes |
| bra_amazon_s | 2024 | 8,9,10 | 2.0 | +1.63 | yes |
| siberia_e | 2021 | 7,8 | 2.6 | +1.62 | yes |
| aus_south_west | 2020 | 1,2 | 1.8 | +1.61 | yes |
| us_west | 2021 | 7,8,9 | 2.2 | +1.51 | yes |
| canada_boreal_e | 2025 | 7,8 | 1.7 | +1.48 | no |
| patagonia | 2025 | 1,2,3 | 1.8 | +1.03 | no |
| bra_amazon_s | 2005 | 8,9,10 | 1.9 | +0.97 | no |
| ven_llanos | 2024 | 2,3 | 1.7 | +0.87 | no |
| ind_gangetic | 2019 | 11 | 1.6 | +0.85 | no |
| aus_north | 2002 | 9,10,11 | 1.6 | +0.44 | no |
| afr_zambezi | 2011 | 9,10 | 1.3 | -0.01 | no |

## Annual totals

| year | true | harmonised | raw MODIS | raw VIIRS | naive sum |
|---|---:|---:|---:|---:|---:|
| 2001 | 21,896,660 | 21,807,774 | 3,632,350 | 0 | 3,632,350 |
| 2002 | 25,665,328 | 23,452,966 | 6,900,680 | 0 | 6,900,680 |
| 2003 | 21,649,900 | 21,551,660 | 8,826,810 | 0 | 8,826,810 |
| 2004 | 23,447,884 | 23,338,929 | 9,558,813 | 0 | 9,558,813 |
| 2005 | 20,842,462 | 20,735,654 | 8,492,602 | 0 | 8,492,602 |
| 2006 | 24,321,938 | 24,219,907 | 9,919,631 | 0 | 9,919,631 |
| 2007 | 18,572,832 | 18,466,955 | 7,563,422 | 0 | 7,563,422 |
| 2008 | 19,578,792 | 19,496,513 | 7,985,093 | 0 | 7,985,093 |
| 2009 | 23,972,750 | 23,855,552 | 9,770,404 | 0 | 9,770,404 |
| 2010 | 28,752,148 | 28,614,038 | 11,719,314 | 0 | 11,719,314 |
| 2011 | 18,452,182 | 18,358,669 | 7,519,072 | 0 | 7,519,072 |
| 2012 | 22,019,100 | 22,011,903 | 8,974,790 | 52,906,553 | 61,881,343 |
| 2013 | 21,717,324 | 21,710,287 | 8,852,750 | 52,180,956 | 61,033,706 |
| 2014 | 23,053,656 | 23,052,768 | 9,395,806 | 53,573,927 | 62,969,733 |
| 2015 | 34,754,160 | 34,761,583 | 14,167,010 | 83,555,207 | 97,722,217 |
| 2016 | 23,589,972 | 23,587,148 | 9,613,153 | 56,695,425 | 66,308,578 |
| 2017 | 22,289,944 | 22,288,702 | 9,083,984 | 53,574,389 | 62,658,373 |
| 2018 | 22,829,164 | 22,829,877 | 9,301,721 | 102,509,398 | 111,811,119 |
| 2019 | 23,971,116 | 23,968,984 | 9,776,614 | 105,862,408 | 115,639,022 |
| 2020 | 22,127,606 | 22,136,519 | 8,898,211 | 97,310,318 | 106,208,529 |
| 2021 | 19,363,490 | 19,362,978 | 7,893,959 | 86,936,338 | 94,830,297 |
| 2022 | 17,447,494 | 17,442,814 | 7,105,988 | 78,321,817 | 85,427,805 |
| 2023 | 26,763,460 | 26,759,721 | 10,904,771 | 119,117,089 | 130,021,860 |
| 2024 | 21,832,748 | 21,836,420 | 8,895,369 | 139,546,555 | 148,441,924 |
| 2025 | 19,388,392 | 19,387,075 | 7,905,484 | 123,879,379 | 131,784,863 |

## Reproduce

```bash
python3 pipeline/calibrate_real.py    # fit the sensor model to real FIRMS data
python3 pipeline/simulate_record.py   # build the 25-year record + app payloads
python3 pipeline/validate.py          # this report
```
