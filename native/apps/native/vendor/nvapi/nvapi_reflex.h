/*********************************************************************************************************\
|*                                                                                                        *|
|* SPDX-FileCopyrightText: Copyright (c) 2019-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.  *|
|* SPDX-License-Identifier: MIT                                                                           *|
|*                                                                                                        *|
|* Permission is hereby granted, free of charge, to any person obtaining a                                *|
|* copy of this software and associated documentation files (the "Software"),                             *|
|* to deal in the Software without restriction, including without limitation                              *|
|* the rights to use, copy, modify, merge, publish, distribute, sublicense,                               *|
|* and/or sell copies of the Software, and to permit persons to whom the                                  *|
|* Software is furnished to do so, subject to the following conditions:                                   *|
|*                                                                                                        *|
|* The above copyright notice and this permission notice shall be included in                             *|
|* all copies or substantial portions of the Software.                                                    *|
|*                                                                                                        *|
|* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR                             *|
|* IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,                               *|
|* FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL                               *|
|* THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER                             *|
|* LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING                                *|
|* FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER                                    *|
|* DEALINGS IN THE SOFTWARE.                                                                              *|
|*                                                                                                        *|
|*                                                                                                        *|
\*********************************************************************************************************/

// Excerpt for NVIDIA Reflex from NVIDIA's NVAPI (https://github.com/NVIDIA/nvapi: nvapi.h, nvapi_lite_common.h
// and nvapi_interface.h, R615). The types and structures are copied unchanged. The functions are looked up at
// run time through nvapi_QueryInterface in the driver's nvapi64.dll, so no NVAPI library is linked.

#pragma once


typedef unsigned char    NvU8;
typedef unsigned int       NvU32; /* 0 to 4294967295                         */
typedef unsigned long long NvU64; /* 0 to 18446744073709551615  */
typedef NvU8 NvBool;

#define MAKE_NVAPI_VERSION(typeName,ver) (NvU32)(sizeof(typeName) | ((ver)<<16))

//! \ingroup dx
typedef struct _NV_SET_SLEEP_MODE_PARAMS
{
    NvU32  version;                                       //!< (IN) Structure version
    NvBool bLowLatencyMode;                               //!< (IN) Low latency mode enable/disable.
    NvBool bLowLatencyBoost;                              //!< (IN) Request maximum GPU clock frequency regardless of workload.
    NvU32  minimumIntervalUs;                             //!< (IN) Minimum frame interval in microseconds. 0 = no frame rate limit.
    NvBool bUseMarkersToOptimize;                         //!< (IN) Allow latency markers to be used for runtime optimizations.
    NvBool bUseMinQueueTime;                              //!< (IN) Consider all submission overlaps (both in between frames and within each frame).
    NvU8   rsvd[30];                                      //!< (IN) Reserved. Must be set to 0s.
} NV_SET_SLEEP_MODE_PARAMS_V1;

typedef NV_SET_SLEEP_MODE_PARAMS_V1            NV_SET_SLEEP_MODE_PARAMS;
#define NV_SET_SLEEP_MODE_PARAMS_VER1          MAKE_NVAPI_VERSION(NV_SET_SLEEP_MODE_PARAMS_V1, 1)
#define NV_SET_SLEEP_MODE_PARAMS_VER           NV_SET_SLEEP_MODE_PARAMS_VER1

//! \ingroup dx
typedef enum
{
    SIMULATION_START               =  0,
    SIMULATION_END                 =  1,
    RENDERSUBMIT_START             =  2,
    RENDERSUBMIT_END               =  3,
    PRESENT_START                  =  4,
    PRESENT_END                    =  5,
    INPUT_SAMPLE                   =  6,
    TRIGGER_FLASH                  =  7,
    PC_LATENCY_PING                =  8,
    OUT_OF_BAND_RENDERSUBMIT_START =  9,
    OUT_OF_BAND_RENDERSUBMIT_END   = 10,
    OUT_OF_BAND_PRESENT_START      = 11,
    OUT_OF_BAND_PRESENT_END        = 12,
} NV_LATENCY_MARKER_TYPE;

//! SUPPORTED OS:  Windows 10 and higher
//!
//! Used set latency markers
//! \ingroup dx
typedef struct _NV_LATENCY_MARKER_PARAMS
{
    NvU32  version;                                       //!< (IN) Structure version
    NvU64  frameID;
    NV_LATENCY_MARKER_TYPE markerType;
    NvU64  rsvd0;
    NvU8   rsvd[56];
} NV_LATENCY_MARKER_PARAMS_V1;

typedef NV_LATENCY_MARKER_PARAMS_V1            NV_LATENCY_MARKER_PARAMS;
#define NV_LATENCY_MARKER_PARAMS_VER1          MAKE_NVAPI_VERSION(NV_LATENCY_MARKER_PARAMS_V1, 1)
#define NV_LATENCY_MARKER_PARAMS_VER           NV_LATENCY_MARKER_PARAMS_VER1

// The ids nvapi_QueryInterface takes, from nvapi_interface.h.
enum NvapiReflexInterfaceId : NvU32 {
    NVAPI_ID_INITIALIZE = 0x0150e828,
    NVAPI_ID_D3D_SET_SLEEP_MODE = 0xac1ca9e0,
    NVAPI_ID_D3D_SLEEP = 0x852cd1d2,
    NVAPI_ID_D3D_SET_LATENCY_MARKER = 0xd9984c05,
};

// NvAPI_Status: NVAPI_OK is 0, failures are negative.
typedef int NvAPI_Status;
#define NVAPI_OK 0
