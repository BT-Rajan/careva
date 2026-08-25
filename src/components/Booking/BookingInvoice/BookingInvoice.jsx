import Footer from '../../Shared/Footer/Footer';
import logo from '../../../images/logo.png';
import './BookingInvoice.css';
import { useParams } from 'react-router-dom';
import { useGetInvoiceByAppointmentQuery } from '../../../redux/api/invoiceApi';
import moment from 'moment';
import { Empty, Button, Tag } from 'antd';
import Header from '../../Shared/Header/Header';
import { useRef } from "react";
import { FaPrint } from "react-icons/fa";
import { useReactToPrint } from "react-to-print";
import { fromMinorUnits } from '../../../utils/money';

const BookingInvoice = () => {
    const printRef = useRef(null);
    const { id } = useParams();
    const { data, isLoading, isError } = useGetInvoiceByAppointmentQuery(id);

    const handlePrint = useReactToPrint({
        contentRef: printRef,
        bodyClass: 'print-agreement',
        documentTitle: () => 'Booking-invoice',
    });

    const STATUS_COLOR = { ISSUED: '#52c41a', PAID: '#1677ff', VOID: '#8c8c8c' };

    let content = null;
    if (isLoading) content = <div>Loading ...</div>
    if (!isLoading && isError) content = <div>Something went Wrong!</div>
    if (!isLoading && !isError && !data) content = <Empty />
    if (!isLoading && !isError && data) content =
        <>
            <div className="col-lg-8 offset-lg-2">
                {/* Pass 14 — Invoice & Financial Records. A corrected invoice's original
                    row is void and stays intact (docs/passes/01-domain-state-model.md
                    §4.5) — surface that plainly rather than showing a superseded
                    document as if it were current. */}
                {data?.status === 'VOID' && data?.supersededBy && (
                    <div className="alert alert-warning mb-2">
                        This invoice has been corrected. The current version is #{data.supersededBy.invoiceNumber}.
                    </div>
                )}
                {data?.status === 'VOID' && !data?.supersededBy && (
                    <div className="alert alert-secondary mb-2">This invoice is void{data?.voidedReason ? `: ${data.voidedReason}` : '.'}</div>
                )}
                {data?.supersedes && (
                    <div className="alert alert-info mb-2">
                        This is a corrected version of invoice #{data.supersedes.invoiceNumber}, issued {moment(data.supersedes.createdAt).format('LL')}.
                    </div>
                )}
                <div className="invoice-content">
                    <div className="invoice-item">
                        <div className="row">
                            <div className="col-md-6">
                                <div className="invoice-logo">
                                    <img src={logo} alt="" />
                                </div>
                            </div>
                            <div className="col-md-6">
                                <p className="invoice-details">
                                    <strong>Invoice:</strong> #{data.invoiceNumber} <Tag color={STATUS_COLOR[data.status]}>{data.status}</Tag><br />
                                    <strong>Issued:</strong> {moment(data.createdAt).format('LL')}
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="invoice-item">
                        <div className="row">
                            <div className="col-md-6">
                                <div className="invoice-info">
                                    <strong className="customer-text">Invoice From</strong>
                                    <p className="invoice-details invoice-details-two">
                                        Dr. {data?.appointment?.doctor?.firstName ? `${data?.appointment?.doctor?.firstName} ${data?.appointment?.doctor?.lastName}`: ' Of Careva'} <br />
                                        {data?.appointment?.doctor?.address ? data?.appointment?.doctor?.address : "Chennai, Tamil Nadu, IN, 600002"}, {data?.appointment?.doctor?.city && data?.appointment?.doctor?.city},<br />
                                        {data?.appointment?.doctor?.country && data?.appointment?.doctor?.country} <br />
                                    </p>
                                </div>
                            </div>
                            <div className="col-md-6">
                                <div className="invoice-info invoice-info2">
                                    <strong className="customer-text">Invoice To</strong>
                                    <p className="invoice-details">
                                        {data?.appointment?.patient?.firstName + ' ' + data?.appointment?.patient?.lastName} <br />
                                        {data?.appointment?.patient?.address}, {data?.appointment?.patient?.city} ,<br />
                                        {data?.appointment?.patient?.country} <br />
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className="invoice-item">
                        <div className="row">
                            <div className="col-md-12">
                                <div className="invoice-info">
                                    <strong className="customer-text">Payment Method</strong>
                                    <p className="invoice-details invoice-details-two">
                                        {data?.payment?.paymentType} <br />
                                        XXXXXXXXXXXX-2541 <br />
                                        {data?.payment?.paymentMethod}<br />
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className="invoice-item invoice-table-wrap">
                        <div className="row">
                            <div className="col-md-12">
                                <div className="table-responsive">
                                    <table className="invoice-table table table-bordered">
                                        <thead>
                                            <tr>
                                                <th>Description</th>
                                                <th className="text-center">Doctor Fee</th>
                                                <th className="text-center">VAT</th>
                                                <th className="text-right">Total</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <tr>
                                                <td>General Consultation</td>
                                                <td className="text-center">{fromMinorUnits(data?.doctorFee, data?.currency)}</td>
                                                <td className="text-center">{fromMinorUnits(data?.vat, data?.currency)}</td>
                                                <td className="text-right">{fromMinorUnits(data?.totalAmount, data?.currency)}</td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                            <div className="col-md-12 col-xl-12 me-auto">
                                <div className="table-responsive">
                                    <table className="invoice-table-two table">
                                        <tbody>
                                            <tr>
                                                <th>Subtotal:</th>
                                                <td><span>{fromMinorUnits(data?.totalAmount, data?.currency)}</span></td>
                                            </tr>
                                            <tr>
                                                <th>Discount:</th>
                                                <td><span>0%</span></td>
                                            </tr>
                                            <tr>
                                                <th>Total Amount:</th>
                                                <td><span>{fromMinorUnits(data?.totalAmount, data?.currency)}</span></td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className="other-info">
                        <h4>Other information</h4>
                        <p className="text-muted mb-0">Lorem ipsum dolor sit amet, consectetur adipiscing elit. Vivamus sed dictum ligula, cursus blandit risus. Maecenas eget metus non tellus dignissim aliquam ut a ex. Maecenas sed vehicula dui, ac suscipit lacus. Sed finibus leo vitae lorem interdum, eu scelerisque tellus fermentum. Curabitur sit amet lacinia lorem. Nullam finibus pellentesque libero.</p>
                    </div>

                </div>
            </div>
        </>
    return (
        <>
            <Header />
            <div className="content" style={{ marginBottom: '7rem', marginTop:'10rem' }}>
                <div className="d-flex justify-content-end mb-4" style={{ marginRight: '8rem' }}>
                    <Button type="primary" icon={<FaPrint />} onClick={handlePrint}>
                        Print
                    </Button>
                </div>
                <div className="container-fluid" ref={printRef}>
                    <div className="row">
                        {content}
                    </div>
                </div>
            </div>
            <Footer />
        </>
    )
}
export default BookingInvoice;